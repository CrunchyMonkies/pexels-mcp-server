import { z } from "zod";

/**
 * Zod schemas for Pexels API responses.
 *
 * Every object schema uses `.passthrough()` so that new fields added by Pexels
 * do not break validation (addresses the API-drift gap). Inferred types are
 * exported and used throughout the service in place of hand-written interfaces.
 */

export const PhotoSourceSchema = z
  .object({
    original: z.string(),
    large2x: z.string(),
    large: z.string(),
    medium: z.string(),
    small: z.string(),
    portrait: z.string(),
    landscape: z.string(),
    tiny: z.string(),
  })
  .passthrough();

export const PhotoSchema = z
  .object({
    id: z.number(),
    width: z.number(),
    height: z.number(),
    url: z.string(),
    photographer: z.string(),
    photographer_url: z.string(),
    photographer_id: z.number(),
    avg_color: z.string().nullable(),
    src: PhotoSourceSchema,
    liked: z.boolean().nullable().optional(),
    alt: z.string().nullable().optional(),
  })
  .passthrough();

export const PhotoSearchResponseSchema = z
  .object({
    total_results: z.number(),
    page: z.number(),
    per_page: z.number(),
    photos: z.array(PhotoSchema),
    next_page: z.string().optional(),
    prev_page: z.string().optional(),
  })
  .passthrough();

export const VideoFileSchema = z
  .object({
    id: z.number(),
    quality: z.string().nullable(),
    file_type: z.string(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    fps: z.number().nullable().optional(),
    link: z.string(),
  })
  .passthrough();

export const VideoPictureSchema = z
  .object({
    id: z.number(),
    nr: z.number(),
    picture: z.string(),
  })
  .passthrough();

export const VideoUserSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    url: z.string(),
  })
  .passthrough();

export const VideoSchema = z
  .object({
    id: z.number(),
    width: z.number(),
    height: z.number(),
    url: z.string(),
    image: z.string(),
    duration: z.number(),
    user: VideoUserSchema,
    video_files: z.array(VideoFileSchema),
    video_pictures: z.array(VideoPictureSchema),
  })
  .passthrough();

export const VideoSearchResponseSchema = z
  .object({
    total_results: z.number(),
    page: z.number(),
    per_page: z.number(),
    videos: z.array(VideoSchema),
    url: z.string().optional(),
    next_page: z.string().optional(),
    prev_page: z.string().optional(),
  })
  .passthrough();

export const CollectionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    private: z.boolean(),
    media_count: z.number(),
    photos_count: z.number(),
    videos_count: z.number(),
  })
  .passthrough();

export const CollectionsResponseSchema = z
  .object({
    collections: z.array(CollectionSchema),
    page: z.number(),
    per_page: z.number(),
    total_results: z.number(),
    next_page: z.string().optional(),
    prev_page: z.string().optional(),
  })
  .passthrough();

/** Collection media items carry a `type` discriminator ("Photo" | "Video"). */
export const CollectionMediaItemSchema = z.union([
  PhotoSchema.extend({ type: z.literal("Photo") }).passthrough(),
  VideoSchema.extend({ type: z.literal("Video") }).passthrough(),
  // Fallback for unexpected/forward-compatible item shapes.
  z.object({ type: z.string() }).passthrough(),
]);

export const CollectionMediaSchema = z
  .object({
    id: z.string(),
    media: z.array(CollectionMediaItemSchema),
    page: z.number(),
    per_page: z.number(),
    total_results: z.number(),
    next_page: z.string().optional(),
    prev_page: z.string().optional(),
  })
  .passthrough();

// Inferred types — used across the service layer.
export type PhotoSource = z.infer<typeof PhotoSourceSchema>;
export type Photo = z.infer<typeof PhotoSchema>;
export type PhotoSearchResponse = z.infer<typeof PhotoSearchResponseSchema>;
export type VideoFile = z.infer<typeof VideoFileSchema>;
export type VideoPicture = z.infer<typeof VideoPictureSchema>;
export type VideoUser = z.infer<typeof VideoUserSchema>;
export type Video = z.infer<typeof VideoSchema>;
export type VideoSearchResponse = z.infer<typeof VideoSearchResponseSchema>;
export type Collection = z.infer<typeof CollectionSchema>;
export type CollectionsResponse = z.infer<typeof CollectionsResponseSchema>;
export type CollectionMedia = z.infer<typeof CollectionMediaSchema>;
