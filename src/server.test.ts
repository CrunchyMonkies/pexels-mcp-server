import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { clearImageCaches } from "./image.js";
import type { PexelsService } from "./services/pexels-service.js";

const photo = {
  id: 1,
  width: 32,
  height: 24,
  url: "https://www.pexels.com/photo/1/",
  photographer: "Jane",
  photographer_url: "https://www.pexels.com/@jane",
  photographer_id: 2,
  avg_color: "#112233",
  src: {
    original: "https://images.example/o.png",
    large2x: "https://images.example/l2.png",
    large: "https://images.example/l.png",
    medium: "https://images.example/m.png",
    small: "https://images.example/s.png",
    portrait: "https://images.example/p.png",
    landscape: "https://images.example/ls.png",
    tiny: "https://images.example/t.png",
  },
  liked: false,
  alt: "alt",
};

function stubService(): PexelsService {
  return {
    searchPhotos: async () => ({
      data: { total_results: 42, page: 1, per_page: 15, photos: [photo] },
      rateLimit: { limit: 20000, remaining: 19999, reset: 1700000000 },
    }),
    getPhoto: async () => ({ data: photo, rateLimit: undefined }),
    setApiKey: () => {},
  } as unknown as PexelsService;
}

async function connect(localMode: boolean) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(stubService(), { localMode });
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearImageCaches();
});

async function mockImageFetch() {
  const fixture = new Uint8Array(await Bun.file("test/fixtures/sample.png").arrayBuffer());
  globalThis.fetch = (async () =>
    new Response(fixture, { status: 200 })) as unknown as typeof fetch;
}

describe("tool registration & localMode gating", () => {
  it("stdio (localMode) registers download tools, not the removed image tools", async () => {
    const client = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("getPhoto");
    expect(names).toContain("downloadPhoto");
    expect(names).toContain("downloadVideo");
    expect(names).not.toContain("transformPhoto");
    expect(names).not.toContain("generatePhotoPlaceholder");
    expect(names).not.toContain("getMyCollections");
  });

  it("HTTP (non-localMode) omits the download tools", async () => {
    const client = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("downloadPhoto");
    expect(names).not.toContain("downloadVideo");
    expect(names).toContain("getPhoto");
    expect(names).toContain("searchPhotos");
  });
});

describe("searchPhotos tool", () => {
  it("returns a summary, JSON and rate-limit text", async () => {
    const client = await connect(true);
    const res: any = await client.callTool({
      name: "searchPhotos",
      arguments: { query: "cats" },
    });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain('Found 42 photos matching "cats"');
    expect(text).toContain("Rate Limit: 19999/20000");
  });
});

describe("getPhoto pipeline", () => {
  it("returns metadata JSON when no pipeline is given", async () => {
    const client = await connect(true);
    const res: any = await client.callTool({ name: "getPhoto", arguments: { id: 1 } });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain('"photographer": "Jane"');
    expect(res.content.find((c: any) => c.type === "image")).toBeUndefined();
  });

  it("returns a processed image block when a pipeline is given", async () => {
    await mockImageFetch();
    const client = await connect(true);
    const res: any = await client.callTool({
      name: "getPhoto",
      arguments: {
        id: 1,
        pipeline: [
          { op: "resize", width: 16, fit: "inside" },
          { op: "cut", left: 0, top: 0, width: 8, height: 6 },
          { op: "format", type: "webp", quality: 80 },
        ],
      },
    });
    const img = res.content.find((c: any) => c.type === "image");
    expect(img).toBeDefined();
    expect(img.mimeType).toBe("image/webp");
    expect(img.data.length).toBeGreaterThan(0);
  });

  it("supports a placeholder pipeline op", async () => {
    await mockImageFetch();
    const client = await connect(true);
    const res: any = await client.callTool({
      name: "getPhoto",
      arguments: { id: 1, pipeline: [{ op: "placeholder" }] },
    });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("data:");
  });

  it("writes to outputPath under localMode", async () => {
    await mockImageFetch();
    const outPath = join(tmpdir(), `pexels-pipe-${Date.now()}.png`);
    const client = await connect(true);
    const res: any = await client.callTool({
      name: "getPhoto",
      arguments: {
        id: 1,
        pipeline: [{ op: "resize", width: 10 }, { op: "format", type: "png" }],
        outputPath: outPath,
      },
    });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain(outPath);
    expect(await Bun.file(outPath).exists()).toBe(true);
  });

  it("rejects outputPath when not in localMode (HTTP)", async () => {
    await mockImageFetch();
    const outPath = join(tmpdir(), `pexels-denied-${Date.now()}.png`);
    const client = await connect(false);
    const res: any = await client.callTool({
      name: "getPhoto",
      arguments: {
        id: 1,
        pipeline: [{ op: "format", type: "png" }],
        outputPath: outPath,
      },
    });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("stdio transport");
    expect(await Bun.file(outPath).exists()).toBe(false);
  });
});
