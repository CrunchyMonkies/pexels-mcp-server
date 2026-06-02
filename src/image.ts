/**
 * Declarative image pipeline built on Bun's native `Bun.Image` API
 * (https://bun.com/docs/runtime/image), with a `cut` (region extract) op
 * implemented via a lossless PNG round-trip through `fast-png` since `Bun.Image`
 * has no native crop.
 *
 * Runs only under the Bun runtime — `Bun.Image` is not available in Node.
 */
import { z } from "zod";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { TtlLruCache, envInt } from "./cache.js";

// --- Pipeline op schemas (zod discriminated union) ---

export const RESIZE_FILTERS = [
  "lanczos3",
  "lanczos2",
  "mitchell",
  "cubic",
  "mks2013",
  "mks2021",
  "bilinear",
  "box",
  "nearest",
] as const;

export const IMAGE_FORMATS = ["jpeg", "png", "webp", "avif", "heic"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

const resizeOp = z.object({
  op: z.literal("resize"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fit: z.enum(["fill", "inside"]).optional(),
  withoutEnlargement: z.boolean().optional(),
  filter: z.enum(RESIZE_FILTERS).optional(),
});
const rotateOp = z.object({
  op: z.literal("rotate"),
  degrees: z.number().describe("Clockwise; multiples of 90"),
});
const flipOp = z.object({ op: z.literal("flip") });
const flopOp = z.object({ op: z.literal("flop") });
const modulateOp = z.object({
  op: z.literal("modulate"),
  brightness: z.number().positive().optional(),
  saturation: z.number().min(0).optional(),
});
const grayscaleOp = z.object({ op: z.literal("grayscale") });
const cutOp = z.object({
  op: z.literal("cut"),
  left: z.number().int().min(0),
  top: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const formatOp = z.object({
  op: z.literal("format"),
  type: z.enum(IMAGE_FORMATS),
  quality: z.number().int().min(1).max(100).optional(),
  progressive: z.boolean().optional(),
  lossless: z.boolean().optional(),
  compressionLevel: z.number().int().min(0).max(9).optional(),
  palette: z.boolean().optional(),
  colors: z.number().int().min(2).max(256).optional(),
  dither: z.boolean().optional(),
});
const placeholderOp = z.object({ op: z.literal("placeholder") });

export const pipelineOpSchema = z.discriminatedUnion("op", [
  resizeOp,
  rotateOp,
  flipOp,
  flopOp,
  modulateOp,
  grayscaleOp,
  cutOp,
  formatOp,
  placeholderOp,
]);
export type PipelineOp = z.infer<typeof pipelineOpSchema>;

export const pipelineSchema = z.array(pipelineOpSchema);

// --- Results ---

export interface ImageResult {
  kind: "image";
  bytes: Uint8Array;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  format: ImageFormat;
}
export interface PlaceholderResult {
  kind: "placeholder";
  dataUrl: string;
}
export type PipelineResult = ImageResult | PlaceholderResult;

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

/** Reject absurdly large inputs (50 MP). */
const MAX_PIXELS = 50 * 1024 * 1024;

/** Type-only handle to the Bun global so this module type-checks everywhere. */
declare const Bun: any;

function ensureBunImage(): void {
  if (typeof Bun === "undefined" || typeof Bun.Image !== "function") {
    throw new Error(
      "Image manipulation requires the Bun runtime (Bun.Image). Run the server with `bun`.",
    );
  }
}

// --- Caches (source bytes + processed results) ---

const CACHE_MAX = envInt("IMAGE_CACHE_MAX", 50);
const CACHE_TTL_MS = envInt("IMAGE_CACHE_TTL_MS", 300_000);

const sourceCache = new TtlLruCache<Uint8Array>(CACHE_MAX, CACHE_TTL_MS);
const resultCache = new TtlLruCache<PipelineResult>(CACHE_MAX, CACHE_TTL_MS);

/** Fetch image bytes for a URL, served from the source cache when warm. */
export async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const cached = sourceCache.get(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status}) from ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  sourceCache.set(url, bytes);
  return bytes;
}

/** Stable cache key for a (source, pipeline) pair. */
export function resultKey(sourceKey: string, ops: PipelineOp[]): string {
  return `${sourceKey}|${JSON.stringify(ops)}`;
}

export function getCachedResult(key: string): PipelineResult | undefined {
  return resultCache.get(key);
}
export function setCachedResult(key: string, result: PipelineResult): void {
  resultCache.set(key, result);
}

/** Test/maintenance helper. */
export function clearImageCaches(): void {
  sourceCache.clear();
  resultCache.clear();
}

// --- Pipeline execution ---

const BUN_OPS = new Set([
  "resize",
  "rotate",
  "flip",
  "flop",
  "modulate",
  "grayscale",
]);

/**
 * Apply a sequence of pipeline ops to image bytes.
 *
 * Contiguous Bun-native ops are batched into one `Bun.Image` chain (Bun applies
 * its canonical order — autoOrient → rotate → flip/flop → resize → modulate —
 * within a batch). A `cut` op forces a boundary so cropping happens at the
 * requested position in the pipeline. `format` selects the final encoder;
 * `placeholder` is terminal.
 */
export async function runPipeline(
  input: Uint8Array | ArrayBuffer,
  ops: PipelineOp[],
): Promise<PipelineResult> {
  ensureBunImage();

  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pendingBun: PipelineOp[] = [];
  let format: ImageFormat = "jpeg";
  let formatOptions: Record<string, unknown> | undefined;
  let formatSpecified = false;

  const flushBun = async () => {
    if (pendingBun.length === 0) return;
    bytes = await encodeWith(bytes, pendingBun, "png", undefined);
    pendingBun = [];
  };

  for (const op of ops) {
    if (BUN_OPS.has(op.op)) {
      pendingBun.push(op);
      continue;
    }
    if (op.op === "cut") {
      // Always materialise current state as PNG (applying any pending Bun ops)
      // so `cut` operates on decodable raw pixels regardless of source format.
      bytes = await encodeWith(bytes, pendingBun, "png", undefined);
      pendingBun = [];
      bytes = cut(bytes, op.left, op.top, op.width, op.height);
      continue;
    }
    if (op.op === "format") {
      // Record the final encoder; applied once at the end.
      format = op.type;
      formatSpecified = true;
      const { op: _o, type: _t, ...rest } = op;
      formatOptions = stripUndefined(rest);
      continue;
    }
    if (op.op === "placeholder") {
      await flushBun();
      const dataUrl = await new Bun.Image(bytes, {
        autoOrient: true,
        maxPixels: MAX_PIXELS,
      }).placeholder();
      return { kind: "placeholder", dataUrl };
    }
  }

  // Final encode: apply any remaining Bun ops + the chosen format together.
  const finalBytes = await encodeWith(
    bytes,
    pendingBun,
    format,
    formatSpecified ? formatOptions : undefined,
  );

  const meta = await new Bun.Image(finalBytes).metadata();
  return {
    kind: "image",
    bytes: finalBytes,
    base64: Buffer.from(finalBytes).toString("base64"),
    mimeType: MIME_BY_FORMAT[format],
    width: meta.width,
    height: meta.height,
    format,
  };
}

/** Build a Bun.Image chain from native ops and encode to the given format. */
async function encodeWith(
  input: Uint8Array,
  bunOps: PipelineOp[],
  format: ImageFormat,
  formatOptions: Record<string, unknown> | undefined,
): Promise<Uint8Array> {
  let img = new Bun.Image(input, { autoOrient: true, maxPixels: MAX_PIXELS });
  img = await applyBunOps(img, input, bunOps);
  img = applyFormat(img, format, formatOptions);

  try {
    return await img.bytes();
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
      throw new Error(
        `Output format "${format}" is not supported on this platform. Try png or webp.`,
      );
    }
    throw err;
  }
}

async function applyBunOps(
  imageStart: any,
  input: Uint8Array,
  bunOps: PipelineOp[],
): Promise<any> {
  let img = imageStart;
  for (const op of bunOps) {
    switch (op.op) {
      case "resize": {
        const resizeOpts = stripUndefined({
          fit: op.fit,
          withoutEnlargement: op.withoutEnlargement,
          filter: op.filter,
        });
        const opts = Object.keys(resizeOpts).length ? resizeOpts : undefined;
        if (op.width != null && op.height != null) {
          img = img.resize(op.width, op.height, opts);
        } else if (op.width != null) {
          img = img.resize(op.width, undefined, opts);
        } else if (op.height != null) {
          // `resize` requires a width — derive it from the source aspect ratio.
          const meta = await new Bun.Image(input).metadata();
          const w = Math.max(1, Math.round((meta.width * op.height) / meta.height));
          img = img.resize(w, op.height, opts);
        }
        break;
      }
      case "rotate":
        img = img.rotate(op.degrees);
        break;
      case "flip":
        img = img.flip();
        break;
      case "flop":
        img = img.flop();
        break;
      case "modulate":
        img = img.modulate(stripUndefined({ brightness: op.brightness, saturation: op.saturation }));
        break;
      case "grayscale":
        img = img.modulate({ saturation: 0 });
        break;
    }
  }
  return img;
}

function applyFormat(
  img: any,
  format: ImageFormat,
  options: Record<string, unknown> | undefined,
): any {
  const opts = options && Object.keys(options).length ? options : undefined;
  switch (format) {
    case "jpeg":
      return img.jpeg(opts);
    case "png":
      return img.png(opts);
    case "webp":
      return img.webp(opts);
    case "avif":
      return img.avif(opts);
    case "heic":
      return img.heic(opts);
  }
}

/**
 * Crop a rectangular region from PNG-encoded bytes (lossless): decode, slice the
 * region row-by-row, re-encode PNG. The caller guarantees `input` is PNG.
 */
function cut(
  input: Uint8Array,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array {
  const img = decodePng(input);
  if (left + width > img.width || top + height > img.height) {
    throw new Error(
      `cut region ${width}x${height}+${left}+${top} exceeds image bounds ${img.width}x${img.height}`,
    );
  }
  const ch = img.channels;
  const TypedArray = img.data.constructor as { new (len: number): typeof img.data };
  const out = new TypedArray(width * height * ch);
  const rowBytes = width * ch;
  for (let y = 0; y < height; y++) {
    const srcStart = ((top + y) * img.width + left) * ch;
    out.set(img.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return new Uint8Array(
    encodePng({ width, height, data: out, channels: ch, depth: img.depth }),
  );
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
