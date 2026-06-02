---
name: pexels-mcp
description: Search Pexels for photos and videos, fetch curated/popular media and collections, and transform images (resize, crop/cut, rotate, flip, greyscale, brightness, format conversion to jpeg/png/webp/avif, and ThumbHash placeholders) through a declarative pipeline. Use when a user wants stock photos or videos from Pexels, or wants to resize/crop/convert/optimize an image, generate a low-quality image placeholder, or download Pexels media. Works through the pexels-mcp-server MCP server.
license: ISC
compatibility: Requires the pexels-mcp-server (Bun) MCP server connected and a PEXELS_API_KEY. Image tools require the Bun runtime (Bun.Image). Download tools and file output are only available when the server runs over stdio.
metadata:
  author: pexels-mcp-server
  version: "2.1"
---

# Pexels MCP

Drive the **pexels-mcp-server** MCP server to find and manipulate Pexels media. This skill
explains the available tools, the image **pipeline**, and the rules that change which tools are
available depending on transport.

## When to use

- The user wants stock **photos** or **videos** (search, curated, popular, collections).
- The user wants to **resize, crop ("cut"), rotate, flip, greyscale, adjust brightness,
  convert format, or optimize** an image — including Pexels photos by ID or any image URL.
- The user wants a **placeholder** (ThumbHash LQIP) for progressive loading.
- The user wants to **download** a Pexels photo/video to a local path (stdio only).

Always preserve Pexels **attribution** in anything shown to an end user: link to Pexels and
credit the photographer/creator (the tools return the attribution string for you).

## Tools

### Discovery / metadata
- `searchPhotos` — `query` (required) + `orientation`, `size` (large=24MP/medium=12MP/small=4MP),
  `color`, `locale`, `page`, `perPage` (1–80, default 15).
- `getCuratedPhotos` — `page`, `perPage`.
- `getPhoto` — `id` (required). Returns metadata JSON **unless** a `pipeline` is supplied
  (then it returns the processed image — see below).
- `searchVideos` — `query` (required) + `orientation`, `size` (large=4K/medium=FullHD/small=HD),
  `locale`, `page`, `perPage`.
- `getPopularVideos` — `minWidth`, `minHeight`, `minDuration`, `maxDuration`, `page`, `perPage`.
- `getVideo` — `id` (required).
- `getFeaturedCollections` — `page`, `perPage`.
- `getCollectionMedia` — `id` (required) + `type` (photos|videos), `sort` (asc|desc), `page`, `perPage`.
- `setApiKey` — `apiKey`. Set the Pexels key at runtime if the server started without one.

> `getMyCollections` is **not** available — it requires Pexels OAuth 2.0.

### Download (stdio transport only)
- `downloadPhoto` — `id` (required), `size` (original|large2x|large|medium|small|portrait|
  landscape|tiny), optional `pipeline`, optional `outputPath`. Without a pipeline it returns a
  download link (or writes the chosen size to `outputPath`).
- `downloadVideo` — `id` (required), `quality` (hd|sd|hls), optional `outputPath`.

When the server runs over **HTTP**, `downloadPhoto`/`downloadVideo` are **not registered** and
`outputPath` is rejected. See [references/pipeline.md](references/pipeline.md) for full details.

## Image pipeline

`getPhoto` and `downloadPhoto` accept a `pipeline`: an **ordered array** of operations applied
to the image. Provide a source via `getPhoto`'s `id` (+ optional `sourceSize`, default `large`).

Operations (each is `{ "op": "...", ... }`):

| op | params | effect |
|----|--------|--------|
| `resize` | `width?`, `height?`, `fit?` (`fill`\|`inside`), `withoutEnlargement?`, `filter?` | scale (omit one dim to keep aspect) |
| `cut` | `left`, `top`, `width`, `height` | extract a rectangular region (crop) |
| `rotate` | `degrees` (multiple of 90) | rotate clockwise |
| `flip` / `flop` | — | mirror vertically / horizontally |
| `modulate` | `brightness?`, `saturation?` | adjust brightness/saturation |
| `grayscale` | — | desaturate |
| `format` | `type` (jpeg\|png\|webp\|avif\|heic), `quality?`, `progressive?`, `lossless?`, `compressionLevel?`, `palette?`, `colors?`, `dither?` | choose output encoder |
| `placeholder` | — | terminal: return a ThumbHash LQIP `data:` URL |

Notes:
- Order matters across a `cut` boundary (e.g. `[resize, cut]` ≠ `[cut, resize]`).
- Default output is **jpeg** if no `format`/`placeholder` op is given.
- `avif`/`heic` may be unsupported on some platforms (e.g. Linux) and return a clear error —
  fall back to `webp` or `png`.
- Results are returned as an MCP image block (base64), or written to `outputPath` (stdio only).

### Examples

Resize to 800px wide, crop a 400×400 region, output WebP:
```json
{ "id": 123, "pipeline": [
  { "op": "resize", "width": 800, "fit": "inside" },
  { "op": "cut", "left": 0, "top": 0, "width": 400, "height": 400 },
  { "op": "format", "type": "webp", "quality": 80 }
] }
```

Greyscale thumbnail as PNG, saved to disk (stdio only):
```json
{ "id": 123, "pipeline": [
  { "op": "resize", "width": 200 },
  { "op": "grayscale" },
  { "op": "format", "type": "png" }
], "outputPath": "/tmp/thumb.png" }
```

Low-quality placeholder for progressive loading:
```json
{ "id": 123, "pipeline": [ { "op": "placeholder" } ] }
```

More ready-to-use payloads are in [assets/examples.json](assets/examples.json).

## Caching & environment

- Source images and processed results are cached in-memory (LRU + TTL). Identical repeat
  requests within the TTL are served from cache.
- Env: `PEXELS_API_KEY` (required), `MCP_TRANSPORT` (`stdio`|`http`), `PORT` (HTTP),
  `IMAGE_CACHE_MAX` (default 50), `IMAGE_CACHE_TTL_MS` (default 300000).
