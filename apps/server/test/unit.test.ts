import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { RateLimiter } from "../src/rateLimiter";

describe("config", () => {
  const ok = { DATABASE_URL: "postgres://x", JWT_SECRET: "s".repeat(32) };
  it("applies defaults", () => {
    const c = loadConfig(ok);
    expect(c.PORT).toBe(4000);
    expect(c.FLUSH_MS).toBe(20);
    expect(c.EVICT_AFTER_MS).toBe(60_000);
  });
  it("rejects a short JWT secret and a missing DATABASE_URL with readable messages", () => {
    expect(() => loadConfig({ ...ok, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: "s".repeat(32) })).toThrow(/DATABASE_URL/);
  });
  it("coerces numbers from strings", () => {
    expect(loadConfig({ ...ok, PORT: "5050" }).PORT).toBe(5050);
  });
});

describe("RateLimiter", () => {
  it("allows a burst, blocks, then refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(3, 1, () => t);
    expect([1, 2, 3, 4].map(() => rl.consume("k"))).toEqual([true, true, true, false]);
    t += 1000;
    expect(rl.consume("k")).toBe(true);
    expect(rl.consume("k")).toBe(false);
  });
  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 0.001, () => 0);
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("b")).toBe(true);
    expect(rl.consume("a")).toBe(false);
  });
});
