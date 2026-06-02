import { describe, it, expect, afterEach } from "bun:test";
import { PexelsService } from "./pexels-service.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const photo = {
  id: 1,
  width: 100,
  height: 100,
  url: "https://www.pexels.com/photo/1/",
  photographer: "P",
  photographer_url: "https://www.pexels.com/@p",
  photographer_id: 2,
  avg_color: "#000000",
  src: {
    original: "o", large2x: "l2", large: "l", medium: "m",
    small: "s", portrait: "p", landscape: "ls", tiny: "t",
  },
  liked: false,
  alt: "a",
};

const searchBody = { total_results: 1, page: 1, per_page: 15, photos: [photo] };

/** Build a captured-request mock that returns the given body/status/headers. */
function mockFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: { url: string; headers: any }[] = [];
  globalThis.fetch = (async (url: any, opts: any) => {
    calls.push({ url: url.toString(), headers: opts?.headers });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: init.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("PexelsService request building", () => {
  it("prefixes photo endpoints with /v1 and sends the Authorization header", async () => {
    const calls = mockFetch(searchBody);
    const svc = new PexelsService("KEY123");
    await svc.searchPhotos("cats", { orientation: "landscape", per_page: 5 });
    expect(calls[0]!.url).toStartWith("https://api.pexels.com/v1/search?");
    expect(calls[0]!.url).toContain("query=cats");
    expect(calls[0]!.url).toContain("orientation=landscape");
    expect(calls[0]!.url).toContain("per_page=5");
    expect(calls[0]!.headers.Authorization).toBe("KEY123");
  });

  it("does NOT prefix video endpoints with /v1", async () => {
    const calls = mockFetch({ total_results: 0, page: 1, per_page: 15, videos: [] });
    const svc = new PexelsService("KEY");
    await svc.searchVideos("ocean");
    expect(calls[0]!.url).toStartWith("https://api.pexels.com/videos/search?");
  });

  it("omits undefined query params", async () => {
    const calls = mockFetch(searchBody);
    const svc = new PexelsService("KEY");
    await svc.searchPhotos("dogs");
    expect(calls[0]!.url).not.toContain("orientation=");
    expect(calls[0]!.url).not.toContain("undefined");
  });

  it("parses rate-limit headers into the response", async () => {
    mockFetch(searchBody, {
      headers: {
        "X-Ratelimit-Limit": "20000",
        "X-Ratelimit-Remaining": "19999",
        "X-Ratelimit-Reset": "1700000000",
      },
    });
    const svc = new PexelsService("KEY");
    const res = await svc.searchPhotos("x");
    expect(res.rateLimit).toEqual({ limit: 20000, remaining: 19999, reset: 1700000000 });
  });

  it("returns undefined rateLimit when no headers are present", async () => {
    mockFetch(searchBody);
    const svc = new PexelsService("KEY");
    const res = await svc.searchPhotos("x");
    expect(res.rateLimit).toBeUndefined();
  });
});

describe("PexelsService validation", () => {
  it("validates a well-formed response", async () => {
    mockFetch(searchBody);
    const svc = new PexelsService("KEY");
    const res = await svc.searchPhotos("x");
    expect(res.data.photos[0]!.id).toBe(1);
  });

  it("throws on a malformed response (zod validation)", async () => {
    mockFetch({ total_results: "not-a-number", photos: "nope" });
    const svc = new PexelsService("KEY");
    await expect(svc.searchPhotos("x")).rejects.toThrow();
  });
});

describe("PexelsService error handling", () => {
  it("requires an API key", async () => {
    const svc = new PexelsService("");
    await expect(svc.getPhoto(1)).rejects.toThrow(/API key is required/);
  });

  it("maps 401 to a friendly message", async () => {
    mockFetch({ error: "bad" }, { status: 401 });
    const svc = new PexelsService("KEY");
    await expect(svc.getPhoto(1)).rejects.toThrow(/Unauthorized/);
  });

  it("maps 404 to a friendly message", async () => {
    mockFetch({}, { status: 404 });
    const svc = new PexelsService("KEY");
    await expect(svc.getPhoto(999)).rejects.toThrow(/not found/i);
  });
});

describe("PexelsService 429 retry/backoff", () => {
  it("retries after a 429 and succeeds, honouring Retry-After", async () => {
    let n = 0;
    const slept: number[] = [];
    globalThis.fetch = (async () => {
      n += 1;
      if (n === 1) {
        return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
      }
      return new Response(JSON.stringify(searchBody), { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new PexelsService("KEY", async (ms) => {
      slept.push(ms);
    });
    const res = await svc.searchPhotos("x");
    expect(n).toBe(2);
    expect(slept[0]).toBe(1000);
    expect(res.data.photos).toHaveLength(1);
  });

  it("gives up after max retries and surfaces the 429 error", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch;

    const svc = new PexelsService("KEY", async () => {});
    await expect(svc.searchPhotos("x")).rejects.toThrow(/Rate limit exceeded/);
    expect(n).toBe(3); // 1 initial + 2 retries
  });
});
