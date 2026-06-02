import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { PexelsService, type RateLimit } from "./services/pexels-service.js";
import {
  runPipeline,
  pipelineSchema,
  fetchImageBytes,
  resultKey,
  getCachedResult,
  setCachedResult,
  type PipelineOp,
} from "./image.js";

const PEXELS_LICENSE = "https://www.pexels.com/license/";

/** Pexels photo `src` size keys, reused across image tools. */
const PHOTO_SIZES = [
  "original",
  "large2x",
  "large",
  "medium",
  "small",
  "portrait",
  "landscape",
  "tiny",
] as const;

const FILE_OUTPUT_STDIO_ONLY =
  "File output is only available over the stdio transport.";

export interface CreateServerOptions {
  /** True when running over stdio: enables download tools + file output. */
  localMode?: boolean;
}

/** Build the human-readable rate-limit line appended to tool responses. */
function rateLimitText(rateLimit?: RateLimit): string | null {
  if (!rateLimit) return null;
  const resetDate = rateLimit.reset
    ? new Date(rateLimit.reset * 1000).toISOString()
    : "N/A";
  return `\nRate Limit: ${rateLimit.remaining ?? "N/A"}/${rateLimit.limit ?? "N/A"} requests remaining this period. Resets at ${resetDate}.`;
}

/** Append a pagination hint when more pages are available. */
function paginationText(meta: {
  page?: number;
  next_page?: string;
  prev_page?: string;
}): string | null {
  if (!meta.next_page && !meta.prev_page) return null;
  const parts: string[] = [];
  if (meta.next_page) parts.push("a next page is available");
  if (meta.prev_page) parts.push("a previous page exists");
  return `\nPagination: ${parts.join("; ")}. Use the \`page\` parameter to navigate.`;
}

const pipelineParam = pipelineSchema
  .optional()
  .describe(
    "Ordered image operations to apply. Ops: resize, rotate, flip, flop, modulate, grayscale, cut (extract a region), format (jpeg/png/webp/avif/heic), placeholder (ThumbHash LQIP). When present, the processed image is returned instead of metadata.",
  );

const outputPathParam = z
  .string()
  .optional()
  .describe(
    "Write the result to this file path and return the path instead of base64. Only available over the stdio transport.",
  );

/**
 * Creates and configures the Pexels MCP server, registering tools and resources
 * against the supplied service. Pure factory — no transport is opened here.
 *
 * `options.localMode` (stdio) enables the download tools and file output.
 */
export function createServer(
  pexels: PexelsService,
  options: CreateServerOptions = {},
): McpServer {
  const localMode = options.localMode ?? false;
  const server = new McpServer({ name: "PexelsMCP", version: "2.1.0" });

  // --- Photo tools ---

  server.tool(
    "searchPhotos",
    {
      query: z
        .string()
        .describe(
          "The search query. Use descriptive keywords for relevant results (e.g., 'Thai hotel reception', 'red sports car driving', not just 'hotel' or 'car').",
        ),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Desired photo orientation"),
      size: z
        .enum(["large", "medium", "small"])
        .optional()
        .describe("Minimum photo size: large (24MP), medium (12MP), small (4MP)"),
      color: z
        .string()
        .optional()
        .describe("Desired photo color (e.g., 'red', 'blue', '#ff0000')"),
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
      locale: z
        .string()
        .optional()
        .describe("The locale of the search query (e.g., 'en-US', 'es-ES')."),
    },
    async ({ query, orientation, size, color, page, perPage, locale }) => {
      try {
        const { data, rateLimit } = await pexels.searchPhotos(query, {
          orientation,
          size,
          color,
          locale,
          page,
          per_page: perPage,
        });
        return textResult(
          `Found ${data.total_results} photos matching "${query}"`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error searching photos", error);
      }
    },
  );

  server.tool(
    "getCuratedPhotos",
    {
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
    },
    async ({ page, perPage }) => {
      try {
        const { data, rateLimit } = await pexels.getCuratedPhotos({
          page,
          per_page: perPage,
        });
        return textResult(
          `Retrieved ${data.photos.length} curated photos`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting curated photos", error);
      }
    },
  );

  server.tool(
    "getPhoto",
    {
      id: z.number().positive().describe("The ID of the photo to retrieve"),
      pipeline: pipelineParam,
      sourceSize: z
        .enum(PHOTO_SIZES)
        .optional()
        .default("large")
        .describe("When a pipeline is given, which Pexels source size to start from"),
      outputPath: outputPathParam,
    },
    async ({ id, pipeline, sourceSize, outputPath }) => {
      try {
        if (pipeline && pipeline.length > 0) {
          const source = await resolveSource(pexels, { id, sourceSize });
          return await processImage(source, pipeline, outputPath, localMode);
        }
        const { data, rateLimit } = await pexels.getPhoto(id);
        return textResult(
          `Retrieved photo: ${data.alt || data.url}`,
          JSON.stringify(data, null, 2),
          null,
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting photo", error);
      }
    },
  );

  if (localMode) {
    server.tool(
      "downloadPhoto",
      {
        id: z.number().positive().describe("The ID of the photo to download"),
        size: z
          .enum(PHOTO_SIZES)
          .optional()
          .default("original")
          .describe("Desired photo size/version"),
        pipeline: pipelineParam,
        outputPath: outputPathParam,
      },
      async ({ id, size, pipeline, outputPath }) => {
        try {
          if (pipeline && pipeline.length > 0) {
            const source = await resolveSource(pexels, { id, sourceSize: size });
            return await processImage(source, pipeline, outputPath, localMode);
          }
          const { data: photo, rateLimit } = await pexels.getPhoto(id);
          let imageUrl = photo.src[size] ?? photo.src.original;
          const actualSize = photo.src[size] ? size : "original";
          if (!imageUrl) {
            return errorResult(
              "Download failed",
              new Error(`Could not find any download URL for photo ID ${id}.`),
            );
          }
          const ext = path.extname(new URL(imageUrl).pathname) || ".jpg";
          const fileName = `pexels_${photo.id}_${actualSize}${ext}`;
          const attribution = `Attribution: Photo by ${photo.photographer} (${photo.photographer_url}) on Pexels. License: ${PEXELS_LICENSE}`;

          if (outputPath) {
            const bytes = await fetchImageBytes(imageUrl);
            await Bun.write(outputPath, bytes);
            return textResult(
              `Wrote ${actualSize} photo to ${outputPath} (${bytes.length} bytes)`,
              attribution,
              rateLimitText(rateLimit),
            );
          }
          return textResult(
            `Download Link (${actualSize}): ${imageUrl}`,
            `Suggested Filename: ${fileName}\n${attribution}\n\nRecommendation: download the link with a local tool, supply 'outputPath' to save it, or pass a 'pipeline' to process it.`,
            rateLimitText(rateLimit),
          );
        } catch (error) {
          return errorResult("Error preparing photo data", error);
        }
      },
    );
  }

  // --- Video tools ---

  server.tool(
    "searchVideos",
    {
      query: z
        .string()
        .describe(
          "The search query. Use descriptive keywords (e.g., 'drone footage beach sunset', 'time lapse city traffic').",
        ),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Desired video orientation"),
      size: z
        .enum(["large", "medium", "small"])
        .optional()
        .describe("Minimum video size: large (4K), medium (Full HD), small (HD)"),
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
      locale: z
        .string()
        .optional()
        .describe("The locale of the search query (e.g., 'en-US', 'es-ES')."),
    },
    async ({ query, orientation, size, page, perPage, locale }) => {
      try {
        const { data, rateLimit } = await pexels.searchVideos(query, {
          orientation,
          size,
          locale,
          page,
          per_page: perPage,
        });
        return textResult(
          `Found ${data.total_results} videos matching "${query}"`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error searching videos", error);
      }
    },
  );

  server.tool(
    "getPopularVideos",
    {
      minWidth: z.number().optional().describe("Minimum video width in pixels"),
      minHeight: z.number().optional().describe("Minimum video height in pixels"),
      minDuration: z.number().optional().describe("Minimum video duration in seconds"),
      maxDuration: z.number().optional().describe("Maximum video duration in seconds"),
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
    },
    async ({ minWidth, minHeight, minDuration, maxDuration, page, perPage }) => {
      try {
        const { data, rateLimit } = await pexels.getPopularVideos({
          min_width: minWidth,
          min_height: minHeight,
          min_duration: minDuration,
          max_duration: maxDuration,
          page,
          per_page: perPage,
        });
        return textResult(
          `Retrieved ${data.videos.length} popular videos`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting popular videos", error);
      }
    },
  );

  server.tool(
    "getVideo",
    { id: z.number().positive().describe("The ID of the video to retrieve") },
    async ({ id }) => {
      try {
        const { data, rateLimit } = await pexels.getVideo(id);
        return textResult(
          `Retrieved video with ID: ${id}`,
          JSON.stringify(data, null, 2),
          null,
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting video", error);
      }
    },
  );

  if (localMode) {
    server.tool(
      "downloadVideo",
      {
        id: z.number().positive().describe("The ID of the video to download"),
        quality: z
          .enum(["hd", "sd", "hls"])
          .optional()
          .default("hd")
          .describe(
            "Preferred video quality: hd, sd, or hls. Falls back to the first available file.",
          ),
        outputPath: outputPathParam,
      },
      async ({ id, quality, outputPath }) => {
        try {
          const { data: video, rateLimit } = await pexels.getVideo(id);
          const videoFile =
            video.video_files.find((vf) => vf.quality === quality) ??
            video.video_files[0];
          if (!videoFile) {
            return errorResult(
              "Download failed",
              new Error(`No video file found for ID ${id}.`),
            );
          }
          const ext = path.extname(new URL(videoFile.link).pathname) || ".mp4";
          const fileName = `pexels_video_${video.id}_${videoFile.quality ?? "file"}${ext}`;
          const attribution = `Attribution: Video by ${video.user.name} (${video.user.url}) on Pexels. License: ${PEXELS_LICENSE}`;

          if (outputPath) {
            const bytes = await fetchImageBytes(videoFile.link);
            await Bun.write(outputPath, bytes);
            return textResult(
              `Wrote ${videoFile.quality ?? "video"} to ${outputPath} (${bytes.length} bytes)`,
              attribution,
              rateLimitText(rateLimit),
            );
          }
          return textResult(
            `Download Link (${videoFile.quality ?? "unknown"}): ${videoFile.link}`,
            `Suggested Filename: ${fileName}\n${attribution}\n\nRecommendation: download the link with a local tool, or supply 'outputPath' to save it.`,
            rateLimitText(rateLimit),
          );
        } catch (error) {
          return errorResult("Error preparing video data", error);
        }
      },
    );
  }

  // --- Collection tools ---

  server.tool(
    "getFeaturedCollections",
    {
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
    },
    async ({ page, perPage }) => {
      try {
        const { data, rateLimit } = await pexels.getFeaturedCollections({
          page,
          per_page: perPage,
        });
        return textResult(
          `Retrieved ${data.collections.length} featured collections`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting featured collections", error);
      }
    },
  );

  server.tool(
    "getCollectionMedia",
    {
      id: z.string().describe("The ID of the collection"),
      type: z.enum(["photos", "videos"]).optional().describe("Filter by media type"),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order (default asc)"),
      page: z.number().positive().optional().describe("Page number (default 1)"),
      perPage: z
        .number()
        .min(1)
        .max(80)
        .optional()
        .describe("Results per page, 1-80 (Pexels default is 15)"),
    },
    async ({ id, type, sort, page, perPage }) => {
      try {
        const { data, rateLimit } = await pexels.getCollectionMedia(id, {
          type,
          sort,
          page,
          per_page: perPage,
        });
        return textResult(
          `Retrieved ${data.media.length} media items from collection ${id}`,
          JSON.stringify(data, null, 2),
          paginationText(data),
          rateLimitText(rateLimit),
        );
      } catch (error) {
        return errorResult("Error getting collection media", error);
      }
    },
  );

  // NOTE: 'getMyCollections' (GET /collections) is intentionally NOT registered.
  // It requires Pexels OAuth 2.0, which this server does not implement.
  // See docs/gap-20260602.md (gap #1).

  // --- Utility tool ---

  server.tool(
    "setApiKey",
    { apiKey: z.string().describe("Your Pexels API key") },
    async ({ apiKey }) => {
      pexels.setApiKey(apiKey);
      return { content: [{ type: "text", text: "API key set successfully" }] };
    },
  );

  // --- Resources (return unwrapped data, matching tool output shape) ---

  server.resource(
    "photo",
    new ResourceTemplate("pexels-photo://{id}", { list: undefined }),
    async (uri, { id }) => {
      try {
        const photoId = parseInt((id ?? "").toString(), 10);
        if (Number.isNaN(photoId)) {
          return resourceText(uri.href, `Invalid photo ID: ${id ?? ""}`);
        }
        const { data } = await pexels.getPhoto(photoId);
        return resourceText(uri.href, JSON.stringify(data, null, 2));
      } catch (error) {
        return resourceText(
          uri.href,
          `Error retrieving photo with ID ${id}: ${(error as Error).message}`,
        );
      }
    },
  );

  server.resource(
    "video",
    new ResourceTemplate("pexels-video://{id}", { list: undefined }),
    async (uri, { id }) => {
      try {
        const videoId = parseInt((id ?? "").toString(), 10);
        if (Number.isNaN(videoId)) {
          return resourceText(uri.href, `Invalid video ID: ${id ?? ""}`);
        }
        const { data } = await pexels.getVideo(videoId);
        return resourceText(uri.href, JSON.stringify(data, null, 2));
      } catch (error) {
        return resourceText(
          uri.href,
          `Error retrieving video with ID ${id}: ${(error as Error).message}`,
        );
      }
    },
  );

  server.resource(
    "collection",
    new ResourceTemplate("pexels-collection://{id}", { list: undefined }),
    async (uri, { id }) => {
      try {
        const { data } = await pexels.getCollectionMedia((id ?? "").toString());
        return resourceText(uri.href, JSON.stringify(data, null, 2));
      } catch (error) {
        return resourceText(
          uri.href,
          `Error retrieving collection with ID ${id}: ${(error as Error).message}`,
        );
      }
    },
  );

  return server;
}

// --- Image helpers ---

interface ImageSource {
  sourceUrl: string;
  bytes: Uint8Array;
  attribution: string | null;
}

/** Resolve image bytes (cached) from a Pexels photo ID or a direct URL. */
async function resolveSource(
  pexels: PexelsService,
  args: { id?: number; url?: string; sourceSize: string },
): Promise<ImageSource> {
  if (args.id == null && !args.url) {
    throw new Error("Provide either `id` (Pexels photo ID) or `url`.");
  }
  let sourceUrl = args.url ?? "";
  let attribution: string | null = null;

  if (args.id != null) {
    const { data: photo } = await pexels.getPhoto(args.id);
    sourceUrl =
      (photo.src as Record<string, string>)[args.sourceSize] ?? photo.src.original;
    attribution = `Attribution: Photo by ${photo.photographer} (${photo.photographer_url}) on Pexels. License: ${PEXELS_LICENSE}`;
  }

  const bytes = await fetchImageBytes(sourceUrl);
  return { sourceUrl, bytes, attribution };
}

/** Run a pipeline (with result caching) and render an MCP tool result. */
async function processImage(
  source: ImageSource,
  pipeline: PipelineOp[],
  outputPath: string | undefined,
  localMode: boolean,
): Promise<ToolResult> {
  if (outputPath && !localMode) {
    return errorResult("File output unavailable", new Error(FILE_OUTPUT_STDIO_ONLY));
  }

  const key = resultKey(source.sourceUrl, pipeline);
  let result = getCachedResult(key);
  if (!result) {
    result = await runPipeline(source.bytes, pipeline);
    setCachedResult(key, result);
  }

  if (result.kind === "placeholder") {
    return textResult(
      "Generated ThumbHash LQIP placeholder (data URL):",
      result.dataUrl,
      source.attribution,
    );
  }

  if (outputPath) {
    await Bun.write(outputPath, result.bytes);
    return textResult(
      `Wrote image to ${outputPath}`,
      `Format: ${result.format} (${result.mimeType}), ${result.width}x${result.height}, ${result.bytes.length} bytes.`,
      source.attribution,
    );
  }

  const content: any[] = [
    {
      type: "text",
      text: `Processed image: ${result.format} ${result.width}x${result.height}, ${result.bytes.length} bytes.${source.attribution ? "\n" + source.attribution : ""}`,
    },
    { type: "image", data: result.base64, mimeType: result.mimeType },
  ];
  return { content };
}

type ToolResult = { content: any[] };

/** Compose a tool result from a summary plus optional extra text blocks. */
function textResult(...lines: (string | null | undefined)[]): ToolResult {
  return {
    content: lines
      .filter((l): l is string => Boolean(l))
      .map((text) => ({ type: "text", text })),
  };
}

function errorResult(prefix: string, error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `${prefix}: ${(error as Error).message}` }],
  };
}

function resourceText(uri: string, text: string) {
  return { contents: [{ uri, text }] };
}

declare const Bun: { write(path: string, data: Uint8Array): Promise<number> };
