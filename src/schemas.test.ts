import { describe, it, expect } from "bun:test";
import {
  PhotoSchema,
  PhotoSearchResponseSchema,
  VideoSchema,
  CollectionsResponseSchema,
  CollectionMediaSchema,
} from "./schemas.js";

const samplePhoto = {
  id: 123,
  width: 4000,
  height: 3000,
  url: "https://www.pexels.com/photo/123/",
  photographer: "Jane Doe",
  photographer_url: "https://www.pexels.com/@jane",
  photographer_id: 7,
  avg_color: "#445566",
  src: {
    original: "https://images.pexels.com/o.jpg",
    large2x: "https://images.pexels.com/l2x.jpg",
    large: "https://images.pexels.com/l.jpg",
    medium: "https://images.pexels.com/m.jpg",
    small: "https://images.pexels.com/s.jpg",
    portrait: "https://images.pexels.com/p.jpg",
    landscape: "https://images.pexels.com/ls.jpg",
    tiny: "https://images.pexels.com/t.jpg",
  },
  liked: false,
  alt: "A photo",
};

const sampleVideo = {
  id: 456,
  width: 1920,
  height: 1080,
  url: "https://www.pexels.com/video/456/",
  image: "https://images.pexels.com/v.jpg",
  duration: 20,
  user: { id: 1, name: "Vid Maker", url: "https://www.pexels.com/@vid" },
  video_files: [
    { id: 1, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, fps: 30, link: "https://.../hd.mp4" },
    { id: 2, quality: "hls", file_type: "application/x-mpegURL", width: null, height: null, link: "https://.../master.m3u8" },
  ],
  video_pictures: [{ id: 9, nr: 0, picture: "https://.../pic.jpg" }],
};

describe("schemas", () => {
  it("parses a valid photo", () => {
    expect(() => PhotoSchema.parse(samplePhoto)).not.toThrow();
  });

  it("parses a photo search response", () => {
    const resp = {
      total_results: 1,
      page: 1,
      per_page: 15,
      photos: [samplePhoto],
      next_page: "https://api.pexels.com/v1/search?page=2",
    };
    const parsed = PhotoSearchResponseSchema.parse(resp);
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.next_page).toContain("page=2");
  });

  it("parses a valid video including an hls file", () => {
    const parsed = VideoSchema.parse(sampleVideo);
    expect(parsed.video_files.some((f) => f.quality === "hls")).toBe(true);
  });

  it("rejects a photo missing required fields", () => {
    const bad = { id: 1, width: 10 };
    expect(() => PhotoSchema.parse(bad)).toThrow();
  });

  it("allows unknown forward-compatible fields (passthrough)", () => {
    const withExtra = { ...samplePhoto, some_new_field: "future" } as any;
    const parsed = PhotoSchema.parse(withExtra) as any;
    expect(parsed.some_new_field).toBe("future");
  });

  it("parses featured collections", () => {
    const resp = {
      collections: [
        { id: "abc", title: "Nature", description: null, private: false, media_count: 10, photos_count: 8, videos_count: 2 },
      ],
      page: 1,
      per_page: 15,
      total_results: 1,
    };
    expect(() => CollectionsResponseSchema.parse(resp)).not.toThrow();
  });

  it("parses collection media with mixed types", () => {
    const resp = {
      id: "abc",
      media: [
        { ...samplePhoto, type: "Photo" },
        { ...sampleVideo, type: "Video" },
      ],
      page: 1,
      per_page: 15,
      total_results: 2,
    };
    const parsed = CollectionMediaSchema.parse(resp);
    expect(parsed.media).toHaveLength(2);
  });
});
