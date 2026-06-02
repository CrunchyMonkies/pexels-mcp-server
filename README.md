# Pexels MCP Server

[![smithery badge](https://smithery.ai/badge/@CaullenOmdahl/pexels-mcp-server)](https://smithery.ai/server/@CaullenOmdahl/pexels-mcp-server)

A Model Context Protocol (MCP) server that provides access to the Pexels API, allowing AI models to search for and retrieve photos, videos, and collections from Pexels.

## Features

- Search for photos and videos by query, orientation, size, and color
- Access curated and popular content from Pexels
- Browse Pexels collections
- Get detailed information about specific photos and videos
- **Image pipeline** — an ordered list of operations (resize / cut / rotate / flip / greyscale /
  modulate / format / placeholder) applied to a photo, powered by the native
  [`Bun.Image`](https://bun.com/docs/runtime/image) API (`cut`/crop uses `fast-png`)
- In-memory **LRU + TTL cache** for source images and processed results
- Access content via tools or direct URI resources
- Runs over **stdio** (default) or **Streamable HTTP**
- Runtime-validated Pexels responses (zod) and a unit-test suite (`bun test`)
- Ships an [Agent Skill](skills/pexels-mcp/SKILL.md) describing how to drive the server

## Requirements

- [Bun](https://bun.com) 1.3.12+ (the `Bun.Image` API is required for the image tools)
- A Pexels API key (get one at [https://www.pexels.com/api/](https://www.pexels.com/api/))

## Local Development

1. Clone the repository
2. Install dependencies
   ```bash
   bun install
   ```
3. Type-check and run the tests
   ```bash
   bun run typecheck
   bun test
   ```
4. Run the server (Bun executes the TypeScript directly — no build step)
   ```bash
   # stdio transport (default)
   PEXELS_API_KEY=your_api_key bun src/main.ts

   # Streamable HTTP transport on http://localhost:3000/mcp
   MCP_TRANSPORT=http PORT=3000 PEXELS_API_KEY=your_api_key bun src/main.ts

   # watch mode
   PEXELS_API_KEY=your_api_key bun run dev
   ```

### Transports

| `MCP_TRANSPORT` | Behaviour |
|-----------------|-----------|
| `stdio` (default) | Communicates over stdin/stdout — for local MCP clients. Enables the `downloadPhoto`/`downloadVideo` tools and file output (`outputPath`). |
| `http` | Serves the MCP Streamable HTTP transport at `/mcp` on `PORT` (default 3000), with `mcp-session-id` session management. The download tools are **not** exposed and `outputPath` is rejected (remote server). |

### Cache configuration

| Env var | Default | Purpose |
|---|---|---|
| `IMAGE_CACHE_MAX` | `50` | Max entries per cache (source bytes and processed results are separate). |
| `IMAGE_CACHE_TTL_MS` | `300000` | Entry time-to-live in milliseconds. |

## Deploying to Smithery

This MCP server is ready to be deployed to Smithery. Follow these steps:

1. Add the server to Smithery or claim an existing server
2. Go to the Deployments tab (only visible to authenticated owners)
3. Deploy the server
4. When configuring the deployment, provide your Pexels API key in the configuration settings

## API Usage

The server provides the following tools:

### Photo Tools

- `searchPhotos`: Search for photos by query (use descriptive keywords for relevant results, e.g., 'Thai hotel reception', 'red sports car driving', not just 'hotel' or 'car'; combine with parameters like `orientation`, `size`, `color`, and `locale` for refined results), with optional filters for orientation, size, color, locale (e.g., 'en-US', 'es-ES'), page, and results per page. Returns metadata including photo IDs and URLs, plus current API rate limit status.
- `downloadPhoto`: Fetches a specific photo by its ID and desired size (optional, defaults to 'original'). Available sizes: 'original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny'. Returns a direct download link for the requested image size, suggested filename (including size), and attribution information. The AI client should use its available local tools (like `curl` or PowerShell's `Invoke-WebRequest`) to download the photo using the provided link.
- `getCuratedPhotos`: Retrieve a curated set of photos from Pexels, optionally paginated.
- `getPhoto`: Retrieve detailed metadata for a photo by ID. Supply a `pipeline` to process and return the image instead (see [Image pipeline](#image-pipeline) below).

> `downloadPhoto` and `downloadVideo` are only registered when running over the **stdio** transport.

### Video Tools

- `searchVideos`: Search for videos by query (use descriptive keywords for relevant results, e.g., 'drone footage beach sunset', 'time lapse city traffic', not just 'beach' or 'city'; combine with parameters like `orientation` and `size` for refined results), with optional filters for orientation, size, locale (e.g., 'en-US', 'es-ES'), page, and results per page. Returns metadata including video IDs and URLs, plus current API rate limit status.
- `getPopularVideos`: Retrieve a list of popular videos from Pexels, with optional filters for dimensions, duration, page, and results per page.
- `getVideo`: Retrieve detailed information about a specific video by its ID.
- `downloadVideo`: Fetches a specific video by its ID and preferred quality (`hd`/`sd`/`hls`). Returns a direct download link, suggested filename, and attribution information. Falls back to the first available file if the requested quality is missing.

### Collection Tools

- `getFeaturedCollections`: Retrieve a list of featured collections from Pexels, optionally paginated.
- ~~`getMyCollections`~~: Requires OAuth 2.0 authentication, not supported by this server (see `docs/gap-20260602.md`).
- `getCollectionMedia`: Retrieve media items (photos or videos) from a specific collection by collection ID, with optional filters for type, sort order, page, and results per page.

### Image pipeline

`getPhoto` (and, over stdio, `downloadPhoto`) accept an optional **`pipeline`** — an ordered
array of operations applied to the source image. The processed image is returned as a base64
`image` content block, or written to `outputPath` (stdio only). Supply the source with
`getPhoto`'s `id` plus an optional `sourceSize` (default `large`).

| op | params | effect |
|----|--------|--------|
| `resize` | `width?`, `height?`, `fit?` (`fill`\|`inside`), `withoutEnlargement?`, `filter?` | scale |
| `cut` | `left`, `top`, `width`, `height` | extract a region (crop) |
| `rotate` | `degrees` (×90) | rotate clockwise |
| `flip` / `flop` | — | mirror vertical / horizontal |
| `modulate` | `brightness?`, `saturation?` | brightness/saturation |
| `grayscale` | — | desaturate |
| `format` | `type` (jpeg\|png\|webp\|avif\|heic), `quality?`, … | output encoder (default jpeg) |
| `placeholder` | — | terminal: ThumbHash LQIP `data:` URL |

Order matters across a `cut` boundary; `avif`/`heic` may be unsupported on some platforms
(e.g. Linux) — prefer `webp`/`png`. Example:

```jsonc
{ "id": 2014422, "pipeline": [
  { "op": "resize", "width": 800, "fit": "inside" },
  { "op": "cut", "left": 0, "top": 0, "width": 400, "height": 400 },
  { "op": "format", "type": "webp", "quality": 80 }
] }
```

See the bundled [Agent Skill](skills/pexels-mcp/SKILL.md) and
[pipeline reference](skills/pexels-mcp/references/pipeline.md) for the full op catalogue.

### Resources

The server provides the following URI-addressable resources:

- `pexels-photo://{id}`: Access a specific photo by ID
- `pexels-video://{id}`: Access a specific video by ID
- `pexels-collection://{id}`: Access a specific collection by ID

## Error Handling

The server attempts to provide informative error messages for common issues like invalid API keys, rate limits, or missing resources. Successful responses also include the current Pexels API rate limit status (remaining requests, reset time) in the output.

## Attribution Requirements

When using the Pexels API, you must follow their attribution requirements:

- Always show a prominent link to Pexels (e.g., "Photos provided by Pexels")
- Always credit photographers (e.g., "Photo by John Doe on Pexels")

## License

ISC