# Pipeline reference

Detailed reference for the `pexels-mcp` image pipeline and transport-dependent behaviour.
Loaded on demand — keep the main `SKILL.md` for the common path.

## Source resolution

`getPhoto` / `downloadPhoto` resolve the image bytes to process from:

- `id` — the Pexels photo ID. The `sourceSize` parameter (default `large`) selects which entry
  of the photo's `src` object to fetch: `original`, `large2x`, `large`, `medium`, `small`,
  `portrait`, `landscape`, `tiny`.
- (`downloadPhoto`) `size` — same set; doubles as the pipeline source size.

The resolved source URL keys the source/result caches.

## Operation semantics

The engine walks the `pipeline` array in order. Contiguous Bun-native ops (`resize`, `rotate`,
`flip`, `flop`, `modulate`, `grayscale`) are batched into a single `Bun.Image` chain. Bun
applies a **canonical order within a batch**: `autoOrient → rotate → flip/flop → resize →
modulate`. A `cut` op forces a boundary (the current state is flushed to a lossless PNG, the
region is sliced, then processing continues), so cropping happens at the position you place it.

### resize
- `width` and/or `height`. Omit one to preserve aspect ratio (height-only derives the width).
- `fit`: `fill` (stretch to exact W×H) or `inside` (fit within W×H, keep aspect). Default `fill`.
- `withoutEnlargement`: never upscale.
- `filter`: resampling kernel — `lanczos3` (default), `lanczos2`, `mitchell`, `cubic`,
  `mks2013`, `mks2021`, `bilinear`, `box`, `nearest`.

### cut
- `left`, `top`, `width`, `height` (all integer pixels). Bounds-checked against the current
  image dimensions; an out-of-range region returns an `exceeds image bounds` error.
- Implemented with a lossless PNG round-trip (Bun.Image has no native crop).

### rotate / flip / flop
- `rotate.degrees` must be a multiple of 90.
- `flip` mirrors across the x-axis; `flop` across the y-axis.

### modulate / grayscale
- `modulate.brightness` (1 = unchanged), `modulate.saturation` (0 = grey, 1 = unchanged, >1 = boost).
- `grayscale` is shorthand for `modulate { saturation: 0 }`.

### format
- `type`: `jpeg`, `png`, `webp`, `avif`, `heic`.
- `quality` (1–100) applies to jpeg/webp/avif/heic.
- jpeg: `progressive`. webp: `lossless`. png: `compressionLevel` (0–9), `palette`, `colors`
  (2–256), `dither`.
- If omitted, output defaults to **jpeg**.
- `avif`/`heic` require platform encoder support; otherwise a clear error is returned — prefer
  `webp`/`png` for portability.

### placeholder
- Terminal op. Returns a ThumbHash LQIP as a `data:image/png;base64,…` URL (~400–700 bytes).
- Any `format` op is ignored when `placeholder` is present.

## Output

- Default: an MCP `image` content block `{ type: "image", data: <base64>, mimeType }` plus a
  text summary and attribution.
- `outputPath` set: the bytes are written to that path and the path is returned. **Only works
  over stdio.** Over HTTP it returns `File output is only available over the stdio transport.`
  and writes nothing.

## Transport differences

| Capability | stdio | HTTP |
|------------|-------|------|
| search / get / curated / popular / collections | ✅ | ✅ |
| `getPhoto` pipeline (image returned as base64) | ✅ | ✅ |
| `downloadPhoto` / `downloadVideo` tools | ✅ | ❌ (not registered) |
| `outputPath` file writing | ✅ | ❌ (rejected) |

## Caching

- `IMAGE_CACHE_MAX` (default 50) — max entries per cache (source + result caches are separate).
- `IMAGE_CACHE_TTL_MS` (default 300000) — entry lifetime in ms.
- Result cache key = resolved source URL + JSON of the pipeline ops. Identical repeats within
  the TTL skip both the upstream fetch and reprocessing.
