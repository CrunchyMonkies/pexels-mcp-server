import { z } from "zod";
import {
  PhotoSchema,
  PhotoSearchResponseSchema,
  VideoSchema,
  VideoSearchResponseSchema,
  CollectionsResponseSchema,
  CollectionMediaSchema,
  type Photo,
  type PhotoSearchResponse,
  type Video,
  type VideoSearchResponse,
  type CollectionsResponse,
  type CollectionMedia,
} from "../schemas.js";

/**
 * Rate-limit information parsed from Pexels response headers.
 */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  reset: number | null; // Unix timestamp (seconds)
}

/**
 * Represents the result of a Pexels API request, including rate limit info.
 */
export interface PexelsApiResponse<T> {
  data: T;
  rateLimit?: RateLimit;
}

/** Options controlling the low-level request behaviour. */
const MAX_RETRIES_ON_429 = 2;
const MAX_BACKOFF_MS = 10_000;

/**
 * Service for interacting with the Pexels API.
 *
 * Uses the runtime's global `fetch` (Bun / modern Node). Responses are validated
 * at runtime against zod schemas before being returned to callers.
 */
export class PexelsService {
  private readonly baseUrl = "https://api.pexels.com";
  private apiKey: string;
  /** Sleep function — overridable in tests to avoid real delays. */
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey?: string, sleep?: (ms: number) => Promise<void>) {
    this.apiKey = apiKey || process.env.PEXELS_API_KEY || "";
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!this.apiKey) {
      console.warn(
        "No Pexels API key provided. Service will not function without an API key.",
      );
    }
  }

  /**
   * Sets the API key for the service.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** Whether an API key is currently configured. */
  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Computes how long to wait before retrying a 429, honouring `Retry-After`
   * (seconds) and `X-Ratelimit-Reset` (Unix timestamp) headers, capped.
   */
  private retryDelayMs(headers: Headers): number {
    const retryAfter = headers.get("Retry-After");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const reset = headers.get("X-Ratelimit-Reset");
    if (reset) {
      const resetMs = parseInt(reset, 10) * 1000 - Date.now();
      if (!Number.isNaN(resetMs) && resetMs > 0) return Math.min(resetMs, MAX_BACKOFF_MS);
    }
    return 1000;
  }

  private parseRateLimit(headers: Headers): RateLimit | undefined {
    const limit = headers.get("X-Ratelimit-Limit");
    const remaining = headers.get("X-Ratelimit-Remaining");
    const reset = headers.get("X-Ratelimit-Reset");
    const rateLimit: RateLimit = {
      limit: limit ? parseInt(limit, 10) : null,
      remaining: remaining ? parseInt(remaining, 10) : null,
      reset: reset ? parseInt(reset, 10) : null,
    };
    return Object.values(rateLimit).some((v) => v !== null) ? rateLimit : undefined;
  }

  /**
   * Makes a validated request to the Pexels API.
   *
   * @param schema  Zod schema used to validate the response body.
   * @param endpoint API endpoint (without the `/v1` prefix; video endpoints start with `/videos`).
   * @param params  Query parameters; `undefined` values are omitted.
   */
  private async request<T>(
    schema: z.ZodType<T>,
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<PexelsApiResponse<T>> {
    if (!this.apiKey) {
      throw new Error(
        "Pexels API key is required. Please set an API key before making requests.",
      );
    }

    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) queryParams.append(key, value.toString());
    });

    // Photo/collection endpoints are under /v1; video endpoints are not.
    const isVideoEndpoint = endpoint.startsWith("/videos");
    const url = `${this.baseUrl}${isVideoEndpoint ? "" : "/v1"}${endpoint}${
      queryParams.toString() ? "?" + queryParams.toString() : ""
    }`;

    let attempt = 0;
    // Retry loop for transient 429s.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await fetch(url, {
        headers: { Authorization: this.apiKey },
      });

      if (response.status === 429 && attempt < MAX_RETRIES_ON_429) {
        attempt += 1;
        await this.sleep(this.retryDelayMs(response.headers));
        continue;
      }

      if (!response.ok) {
        throw new Error(await this.buildErrorMessage(response));
      }

      const json = await response.json();
      const data = schema.parse(json);
      return { data, rateLimit: this.parseRateLimit(response.headers) };
    }
  }

  private async buildErrorMessage(response: Response): Promise<string> {
    let errorBody = "";
    try {
      const errorJson = (await response.json()) as { error?: string; code?: string };
      errorBody = errorJson.error || errorJson.code || "";
    } catch {
      try {
        errorBody = await response.text();
      } catch {
        errorBody = "";
      }
    }

    switch (response.status) {
      case 401:
        return `Pexels API Error (401): Unauthorized. Check your API key.`;
      case 404:
        return `Pexels API Error (404): Resource not found.`;
      case 429:
        return `Pexels API Error (429): Rate limit exceeded. Please wait and try again.`;
      default:
        return `Pexels API Error (${response.status}): ${errorBody}`;
    }
  }

  // --- Photos ---

  async searchPhotos(
    query: string,
    options: {
      orientation?: "landscape" | "portrait" | "square";
      size?: "large" | "medium" | "small";
      color?: string;
      locale?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<PexelsApiResponse<PhotoSearchResponse>> {
    return this.request(PhotoSearchResponseSchema, "/search", { query, ...options });
  }

  async getCuratedPhotos(
    options: { page?: number; per_page?: number } = {},
  ): Promise<PexelsApiResponse<PhotoSearchResponse>> {
    return this.request(PhotoSearchResponseSchema, "/curated", options);
  }

  async getPhoto(id: number): Promise<PexelsApiResponse<Photo>> {
    return this.request(PhotoSchema, `/photos/${id}`);
  }

  // --- Videos ---

  async searchVideos(
    query: string,
    options: {
      orientation?: "landscape" | "portrait" | "square";
      size?: "large" | "medium" | "small";
      locale?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<PexelsApiResponse<VideoSearchResponse>> {
    return this.request(VideoSearchResponseSchema, "/videos/search", { query, ...options });
  }

  async getPopularVideos(
    options: {
      min_width?: number;
      min_height?: number;
      min_duration?: number;
      max_duration?: number;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<PexelsApiResponse<VideoSearchResponse>> {
    return this.request(VideoSearchResponseSchema, "/videos/popular", options);
  }

  async getVideo(id: number): Promise<PexelsApiResponse<Video>> {
    return this.request(VideoSchema, `/videos/videos/${id}`);
  }

  // --- Collections ---

  async getFeaturedCollections(
    options: { page?: number; per_page?: number } = {},
  ): Promise<PexelsApiResponse<CollectionsResponse>> {
    return this.request(CollectionsResponseSchema, "/collections/featured", options);
  }

  /**
   * Get the authenticated user's collections.
   *
   * NOTE: This endpoint requires Pexels OAuth 2.0, which is not implemented by
   * this server. Kept for completeness; the corresponding MCP tool is not
   * registered. See docs/gap-20260602.md (gap #1).
   */
  async getMyCollections(
    options: { page?: number; per_page?: number } = {},
  ): Promise<PexelsApiResponse<CollectionsResponse>> {
    return this.request(CollectionsResponseSchema, "/collections", options);
  }

  async getCollectionMedia(
    id: string,
    options: {
      type?: "photos" | "videos";
      sort?: "asc" | "desc";
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<PexelsApiResponse<CollectionMedia>> {
    return this.request(CollectionMediaSchema, `/collections/${id}`, options);
  }
}
