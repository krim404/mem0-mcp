import { describe, expect, test } from "bun:test";
import { classifyExpiry, computeExpirationDate, daysPastExpiry, RECENT_MAX_DAYS, HIDDEN_MAX_DAYS } from "./expiry";

const NOW = new Date("2026-07-15T12:00:00Z");
// A date `n` days from NOW (negative = in the past), reusing the production helper.
const at = (n: number) => computeExpirationDate(n, NOW);

describe("classifyExpiry", () => {
  test("no expiration date → active (never expires)", () => {
    expect(classifyExpiry(undefined, NOW)).toBe("active");
  });

  test("today or future → active", () => {
    expect(classifyExpiry(at(0), NOW)).toBe("active");
    expect(classifyExpiry(at(5), NOW)).toBe("active");
  });

  test("1..RECENT_MAX_DAYS past → recent (shown at the bottom)", () => {
    expect(classifyExpiry(at(-1), NOW)).toBe("recent");
    expect(classifyExpiry(at(-RECENT_MAX_DAYS), NOW)).toBe("recent");
  });

  test("past RECENT_MAX_DAYS up to HIDDEN_MAX_DAYS → hidden", () => {
    expect(classifyExpiry(at(-(RECENT_MAX_DAYS + 1)), NOW)).toBe("hidden");
    expect(classifyExpiry(at(-HIDDEN_MAX_DAYS), NOW)).toBe("hidden");
  });

  test("beyond HIDDEN_MAX_DAYS → dead (GC)", () => {
    expect(classifyExpiry(at(-(HIDDEN_MAX_DAYS + 1)), NOW)).toBe("dead");
  });

  test("malformed date → active (fail safe, never auto-delete)", () => {
    expect(classifyExpiry("not-a-date", NOW)).toBe("active");
  });
});

describe("daysPastExpiry", () => {
  test("null without a date", () => {
    expect(daysPastExpiry(undefined, NOW)).toBeNull();
  });
  test("positive when past, non-positive when active", () => {
    expect(daysPastExpiry(at(-3), NOW)).toBe(3);
    expect(daysPastExpiry(at(0), NOW)).toBe(0);
    expect(daysPastExpiry(at(10), NOW)).toBe(-10);
  });
});

describe("computeExpirationDate", () => {
  test("returns a YYYY-MM-DD day-granularity date", () => {
    expect(computeExpirationDate(1, NOW)).toBe("2026-07-16");
    expect(computeExpirationDate(90, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
