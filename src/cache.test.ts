import { describe, it, expect } from "bun:test";
import { TtlLruCache, envInt } from "./cache.js";

describe("TtlLruCache", () => {
  it("stores and retrieves values", () => {
    const c = new TtlLruCache<number>(10, 1000);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.get("missing")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const c = new TtlLruCache<number>(2, 1000);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // touch 'a' so 'b' becomes LRU
    c.set("c", 3); // evicts 'b'
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
    expect(c.size).toBe(2);
  });

  it("expires entries after the TTL using an injected clock", () => {
    let now = 1000;
    const c = new TtlLruCache<string>(10, 500, () => now);
    c.set("k", "v");
    now = 1400; // within TTL
    expect(c.get("k")).toBe("v");
    now = 1600; // past TTL (1000 + 500)
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("overwrite resets recency and TTL", () => {
    let now = 0;
    const c = new TtlLruCache<number>(10, 100, () => now);
    c.set("k", 1);
    now = 90;
    c.set("k", 2); // resets expiry to now+100 = 190
    now = 150;
    expect(c.get("k")).toBe(2);
  });

  it("maxEntries <= 0 disables caching", () => {
    const c = new TtlLruCache<number>(0, 1000);
    c.set("a", 1);
    expect(c.get("a")).toBeUndefined();
  });
});

describe("envInt", () => {
  it("returns the fallback when unset", () => {
    delete process.env.__TEST_ENVINT__;
    expect(envInt("__TEST_ENVINT__", 42)).toBe(42);
  });

  it("parses a positive integer", () => {
    process.env.__TEST_ENVINT__ = "7";
    expect(envInt("__TEST_ENVINT__", 42)).toBe(7);
    delete process.env.__TEST_ENVINT__;
  });

  it("falls back on invalid/non-positive values", () => {
    process.env.__TEST_ENVINT__ = "-3";
    expect(envInt("__TEST_ENVINT__", 42)).toBe(42);
    process.env.__TEST_ENVINT__ = "abc";
    expect(envInt("__TEST_ENVINT__", 42)).toBe(42);
    delete process.env.__TEST_ENVINT__;
  });
});
