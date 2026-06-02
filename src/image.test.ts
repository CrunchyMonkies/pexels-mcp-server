import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import {
  runPipeline,
  fetchImageBytes,
  resultKey,
  getCachedResult,
  setCachedResult,
  clearImageCaches,
  type ImageResult,
} from "./image.js";

let source: Uint8Array; // 32x24 PNG fixture

beforeAll(async () => {
  source = new Uint8Array(await Bun.file("test/fixtures/sample.png").arrayBuffer());
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearImageCaches();
});

function asImage(r: Awaited<ReturnType<typeof runPipeline>>): ImageResult {
  if (r.kind !== "image") throw new Error("expected image result");
  return r;
}

describe("runPipeline geometry & format", () => {
  it("resizes by width preserving aspect ratio and converts to webp", async () => {
    const r = asImage(
      await runPipeline(source, [
        { op: "resize", width: 16, fit: "inside" },
        { op: "format", type: "webp", quality: 80 },
      ]),
    );
    expect(r.format).toBe("webp");
    expect(r.mimeType).toBe("image/webp");
    expect(r.width).toBe(16);
    expect(r.height).toBe(12);
    expect(r.bytes.length).toBeGreaterThan(0);
    expect(r.base64.length).toBeGreaterThan(0);
  });

  it("resizes by height only (width derived from aspect ratio)", async () => {
    const r = asImage(
      await runPipeline(source, [
        { op: "resize", height: 12 },
        { op: "format", type: "png" },
      ]),
    );
    expect(r.height).toBe(12);
    expect(r.width).toBe(16);
    expect(r.mimeType).toBe("image/png");
  });

  it("defaults to jpeg when no format op is given", async () => {
    const r = asImage(await runPipeline(source, [{ op: "resize", width: 8 }]));
    expect(r.format).toBe("jpeg");
  });

  it("applies grayscale and brightness via modulate", async () => {
    const r = asImage(
      await runPipeline(source, [
        { op: "grayscale" },
        { op: "modulate", brightness: 1.1 },
        { op: "format", type: "png" },
      ]),
    );
    expect(r.width).toBe(32);
    expect(r.height).toBe(24);
  });
});

describe("runPipeline cut (crop) — order sensitive", () => {
  it("cuts an exact region from the source", async () => {
    const r = asImage(
      await runPipeline(source, [{ op: "cut", left: 4, top: 3, width: 10, height: 8 }]),
    );
    expect(r.width).toBe(10);
    expect(r.height).toBe(8);
  });

  it("[resize, cut] cuts from the resized image", async () => {
    const r = asImage(
      await runPipeline(source, [
        { op: "resize", width: 16 }, // -> 16x12
        { op: "cut", left: 0, top: 0, width: 8, height: 6 },
        { op: "format", type: "png" },
      ]),
    );
    expect(r.width).toBe(8);
    expect(r.height).toBe(6);
  });

  it("[cut, resize] resizes the cropped region", async () => {
    const r = asImage(
      await runPipeline(source, [
        { op: "cut", left: 0, top: 0, width: 16, height: 12 },
        { op: "resize", width: 32 }, // 16x12 -> 32x24
      ]),
    );
    expect(r.width).toBe(32);
    expect(r.height).toBe(24);
  });

  it("rejects an out-of-bounds region", async () => {
    await expect(
      runPipeline(source, [{ op: "cut", left: 30, top: 0, width: 10, height: 5 }]),
    ).rejects.toThrow(/exceeds image bounds/);
  });
});

describe("runPipeline placeholder", () => {
  it("returns a ThumbHash data URL", async () => {
    const r = await runPipeline(source, [{ op: "placeholder" }]);
    expect(r.kind).toBe("placeholder");
    if (r.kind === "placeholder") expect(r.dataUrl).toStartWith("data:");
  });
});

describe("fetchImageBytes caching", () => {
  it("caches by URL and does not re-fetch within TTL", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(source, { status: 200 });
    }) as unknown as typeof fetch;

    const a = await fetchImageBytes("https://example/img.png");
    const b = await fetchImageBytes("https://example/img.png");
    expect(calls).toBe(1);
    expect(b).toBe(a);
  });

  it("throws on a failed fetch", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchImageBytes("https://example/missing.png")).rejects.toThrow(/404/);
  });
});

describe("result cache helpers", () => {
  it("stores and retrieves a result by (source, pipeline) key", async () => {
    const ops = [{ op: "resize", width: 8 } as const];
    const key = resultKey("https://example/x.png", ops);
    expect(getCachedResult(key)).toBeUndefined();
    const r = await runPipeline(source, ops);
    setCachedResult(key, r);
    expect(getCachedResult(key)).toBe(r);
  });
});
