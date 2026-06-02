# Pexels MCP Server — Specification

> Descriptive specification of the server **as built** (v2.0.0). For the comparison against
> the official [Pexels API](https://www.pexels.com/api/documentation/) and remaining gaps,
> see [`gap-20260602.md`](./gap-20260602.md).

## 1. Overview

`pexels-mcp-server` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that wraps the [Pexels API](https://www.pexels.com/api/documentation/), exposing
photo, video, and collection search/retrieval — plus native image manipulation — as MCP
**tools** and **resources**.

| | |
|---|---|
| Package name | `pexels-mcp-server` |
| Version | `2.1.0` |
| MCP server name | `PexelsMCP` |
| Transports | stdio (default) and Streamable HTTP |
| Runtime | Bun 1.3.12+ (TypeScript executed directly) |
| Validation | zod — tool inputs **and** Pexels responses |
| License | ISC |

The server runs either as a stdio subprocess (for local MCP clients) or as a Streamable HTTP
service (for remote clients), selected via the `MCP_TRANSPORT` environment variable.

## 2. Architecture

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point. Reads `MCP_TRANSPORT` and connects either the stdio transport or the HTTP server. |
| `src/server.ts` | `createServer(pexels, { localMode })` — registers tools + resources and formats responses. `localMode` (stdio) gates the download tools + file output. Pure factory, unit-testable. |
| `src/services/pexels-service.ts` | Pexels HTTP client — builds requests, injects auth, parses rate-limit headers, retries 429s, maps errors, and validates responses with zod. |
| `src/schemas.ts` | Zod schemas for all Pexels response objects + inferred types. |
| `src/image.ts` | `Bun.Image` pipeline engine (`runPipeline`, op schemas), `cut` via `fast-png`, and the source/result caches. |
| `src/cache.ts` | `TtlLruCache` (LRU + TTL) and `envInt` config helper. |
| `src/transports/http.ts` | Streamable HTTP transport over `node:http`, with session management. |

Request flow: a tool handler in `server.ts` calls a method on the shared `PexelsService`,
which issues a single validated `GET` to the Pexels API and returns a `{ data, rateLimit }`
envelope. The handler stringifies `data` and appends human-readable pagination and rate-limit
lines before returning MCP `content` blocks.

The Pexels base URL is `https://api.pexels.com`. Photo and collection endpoints are prefixed
with `/v1`; video endpoints (paths starting with `/videos`) are **not** prefixed.

## 3. Transports

Selected by `MCP_TRANSPORT` in `src/main.ts`:

- **`stdio`** (default): `StdioServerTransport` over stdin/stdout.
- **`http`**: `StreamableHTTPServerTransport` served on `node:http` at `/mcp`, port from
  `PORT` (default 3000). An `initialize` POST creates a session and returns an
  `mcp-session-id`; later requests (POST/GET/DELETE) reuse the transport for that session.

Transport sets `localMode`: stdio → `true`, http → `false`. `localMode` gates **(a)** the
registration of `downloadPhoto`/`downloadVideo` and **(b)** file output (`outputPath`). Over
HTTP the download tools are absent from `tools/list` and any `outputPath` is rejected with
`"File output is only available over the stdio transport."`.

## 4. Authentication

The Pexels API key is supplied as the `Authorization` header on every request. It is
resolved in priority order: constructor argument → `PEXELS_API_KEY` env → the `setApiKey`
tool at runtime. If no key is present, the constructor warns and any request throws
`Pexels API key is required. Please set an API key before making requests.`

## 5. Tools

Search/retrieval tools return a summary line, the raw Pexels JSON (pretty-printed), an
optional pagination hint, and — when the headers are present — a trailing rate-limit line
(see §8). Image tools return an `image` content block or a written-file path. Tool handlers
never throw; errors are caught and returned as a `text` block (see §9).

> MCP tools use camelCase `perPage`, mapped to the Pexels `per_page` query parameter. When
> omitted, the Pexels default of **15** applies (max **80**); this is noted in each
> list-tool's description.

### Photo tools
- **`searchPhotos`** → `GET /v1/search`. Params: `query` (req), `orientation`, `size`
  (large 24MP / medium 12MP / small 4MP), `color`, `page`, `perPage`, `locale`.
- **`getCuratedPhotos`** → `GET /v1/curated`. Params: `page`, `perPage`.
- **`getPhoto`** → `GET /v1/photos/{id}`. Params: `id` (req), optional `pipeline`, `sourceSize`
  (default `large`), `outputPath`. No pipeline → full Photo object (metadata). With a pipeline →
  the processed image (see §5.1).
- **`downloadPhoto`** (stdio only) → `GET /v1/photos/{id}`. Params: `id` (req), `size` (default
  `original`; one of `original|large2x|large|medium|small|portrait|landscape|tiny`), optional
  `pipeline`, `outputPath`. No pipeline → download URL + attribution (or writes the chosen size
  to `outputPath`). With a pipeline → processed image (§5.1).

### Video tools
- **`searchVideos`** → `GET /videos/search`. Params: `query` (req), `orientation`, `size`
  (large 4K / medium Full HD / small HD), `page`, `perPage`, `locale`.
- **`getPopularVideos`** → `GET /videos/popular`. Params: `minWidth`, `minHeight`,
  `minDuration`, `maxDuration`, `page`, `perPage` (mapped to `min_*`/`per_page`).
- **`getVideo`** → `GET /videos/videos/{id}`. Param: `id` (req).
- **`downloadVideo`** (stdio only) → `GET /videos/videos/{id}`. Params: `id` (req), `quality`
  (default `hd`; one of `hd|sd|hls`), optional `outputPath`. Selects the matching `video_files`
  entry, falling back to the first available. Returns a download URL + attribution, or writes
  the file to `outputPath`.

### Collection tools
- **`getFeaturedCollections`** → `GET /v1/collections/featured`. Params: `page`, `perPage`.
- **`getCollectionMedia`** → `GET /v1/collections/{id}`. Params: `id` (req), `type`
  (`photos|videos`), `sort` (`asc|desc`), `page`, `perPage`.
- `getMyCollections` (`GET /v1/collections`) is **not** registered — OAuth 2.0 required
  (see gap #1).

### Utility
- **`setApiKey`**: sets the Pexels API key on the running service. Param: `apiKey` (req).

## 5.1 Image pipeline

`getPhoto` and `downloadPhoto` accept a `pipeline`: an ordered array of operations applied to
the source image (resolved from `photo.src[sourceSize]`). Implemented in `src/image.ts`
(`runPipeline`). Contiguous `Bun.Image`-native ops are batched into one chain (Bun's canonical
order `autoOrient → rotate → flip/flop → resize → modulate` applies within a batch); a `cut`
op forces a boundary and is performed via a lossless PNG round-trip through `fast-png` (since
`Bun.Image` has no native crop).

| op | params | notes |
|---|---|---|
| `resize` | `width?`, `height?`, `fit?` (`fill`\|`inside`), `withoutEnlargement?`, `filter?` | omit one dim to keep aspect (height-only derives width) |
| `cut` | `left`, `top`, `width`, `height` | region extract; bounds-checked |
| `rotate` | `degrees` | multiples of 90 |
| `flip` / `flop` | — | mirror x / y |
| `modulate` | `brightness?`, `saturation?` | |
| `grayscale` | — | `modulate { saturation: 0 }` |
| `format` | `type` (`jpeg\|png\|webp\|avif\|heic`), `quality?`, `progressive?`, `lossless?`, `compressionLevel?`, `palette?`, `colors?`, `dither?` | default output `jpeg` |
| `placeholder` | — | terminal: ThumbHash LQIP `data:` URL |

Output: an MCP `image` content block (base64) + attribution, or a write to `outputPath`
(stdio only). `avif`/`heic` may be unsupported on a platform (e.g. Linux) → clear error.

## 5.2 Image cache

`src/cache.ts` provides `TtlLruCache` (Map-based LRU + per-entry TTL). `src/image.ts` keeps two
instances: a **source-bytes** cache keyed by resolved URL, and a **result** cache keyed by
`{url}|{JSON pipeline}`. Both are bounded by `IMAGE_CACHE_MAX` (default 50) entries with
`IMAGE_CACHE_TTL_MS` (default 300000 ms) lifetime. Identical repeat requests within the TTL
skip both the upstream fetch and reprocessing.

## 6. Resources

Three URI-template resources (no `list` support). Each returns the **unwrapped** entity JSON
(matching tool output). Photo/video resources validate that the ID is numeric.

| Resource | URI template | Backing call |
|---|---|---|
| `photo` | `pexels-photo://{id}` | `getPhoto(id)` |
| `video` | `pexels-video://{id}` | `getVideo(id)` |
| `collection` | `pexels-collection://{id}` | `getCollectionMedia(id)` |

## 7. Data schemas (zod)

`src/schemas.ts` defines zod schemas for `Photo` (+ `PhotoSource`), `Video` (+ `VideoFile`,
`VideoPicture`, `VideoUser`), `Collection`, and the list-response envelopes
(`page`, `per_page`, `total_results`, `next_page?`, `prev_page?` plus
`photos`/`videos`/`collections`/`media`). All object schemas use `.passthrough()` so new
Pexels fields are preserved rather than rejected. Inferred types (`z.infer`) are used
throughout the service in place of hand-written interfaces. Responses are validated at
runtime in `PexelsService.request` via `schema.parse(json)`.

## 8. Rate limiting

After a successful response, `PexelsService` parses `X-Ratelimit-Limit`,
`X-Ratelimit-Remaining`, and `X-Ratelimit-Reset` into `{ limit, remaining, reset }`
(undefined when no headers present). Each tool appends:

```
Rate Limit: {remaining}/{limit} requests remaining this period. Resets at {ISO-8601}.
```

On **HTTP 429**, the request is retried up to 2 times, waiting per `Retry-After` (seconds) or
`X-Ratelimit-Reset` (Unix timestamp), capped at 10s. If still rate-limited, the friendly 429
error is surfaced.

## 9. Error handling

`PexelsService.request` throws on non-2xx responses, mapping 401 → "Unauthorized. Check your
API key.", 404 → "Resource not found.", 429 → "Rate limit exceeded. Please wait and try
again.", and other statuses to `Pexels API Error ({status}): {body}`. Every tool handler
wraps the call in `try/catch` and returns the message as a `text` block, so tools always
resolve at the MCP layer.

## 10. Build, run & deployment

| Task | Command |
|---|---|
| Install | `bun install` |
| Type-check | `bun run typecheck` (`tsc --noEmit`) |
| Test | `bun test` |
| Run (stdio) | `PEXELS_API_KEY=… bun src/main.ts` |
| Run (HTTP) | `MCP_TRANSPORT=http PORT=3000 PEXELS_API_KEY=… bun src/main.ts` |
| Watch | `bun run dev` |

Bun executes the TypeScript directly — there is no build/emit step. **Dependencies:**
`@modelcontextprotocol/sdk`, `zod`, `fast-png` (lossless crop). **Dev:** `@types/bun`,
`typescript`. **Docker**: based on
`oven/bun:1`, `bun install --production`, `CMD ["bun", "src/main.ts"]`. **Smithery**
(`smithery.yaml`): `type: stdio`, `command: bun`, `args: ["src/main.ts"]`, key injected as
`env.PEXELS_API_KEY`.

## 11. Endpoint & tool reference

| Tool / Resource | Method & path | Params |
|---|---|---|
| `searchPhotos` | `GET /v1/search` | `query, orientation, size, color, locale, page, per_page` |
| `getCuratedPhotos` | `GET /v1/curated` | `page, per_page` |
| `getPhoto` (+ `pipeline`), `downloadPhoto` (stdio), `photo` resource | `GET /v1/photos/{id}` | `id` (+ pipeline/sourceSize/outputPath) |
| `searchVideos` | `GET /videos/search` | `query, orientation, size, locale, page, per_page` |
| `getPopularVideos` | `GET /videos/popular` | `min_width, min_height, min_duration, max_duration, page, per_page` |
| `getVideo`, `downloadVideo` (stdio), `video` resource | `GET /videos/videos/{id}` | `id` (+ quality/outputPath) |
| `getFeaturedCollections` | `GET /v1/collections/featured` | `page, per_page` |
| `getCollectionMedia`, `collection` resource | `GET /v1/collections/{id}` | `id, type, sort, page, per_page` |
| `setApiKey` | — (local) | `apiKey` |

> Image manipulation is no longer a standalone tool — it is the `pipeline` parameter on
> `getPhoto`/`downloadPhoto` (see §5.1). The former `transformPhoto`/`generatePhotoPlaceholder`
> tools were removed in v2.1.0.
