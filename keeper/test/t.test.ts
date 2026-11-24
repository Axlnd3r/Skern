import { describe, expect, it } from "vitest";
import { computeT, toBps } from "../src/t";

describe("toBps", () => {
  it("converts a price to integer bp relative to p0", () => {
    expect(toBps(100.1, 100)).toBe(10);
    expect(toBps(99.9, 100)).toBe(-10);
    expect(toBps(100, 100)).toBe(0);
  });

  it("never returns negative zero", () => {
    expect(Object.is(toBps(100.0001, 100), 0)).toBe(true);
    expect(Object.is(toBps(99.9999, 100), 0)).toBe(true);
  });

  it("rejects non-finite input and p0 <= 0", () => {
    expect(() => toBps(NaN, 100)).toThrow();
    expect(() => toBps(Infinity, 100)).toThrow();
    expect(() => toBps(100, 0)).toThrow();
    expect(() => toBps(100, -5)).toThrow();
    expect(() => toBps(100, NaN)).toThrow();
  });

  it("rejects a result outside int32", () => {
    expect(() => toBps(1e12, 1)).toThrow();
  });
});

describe("computeT", () => {
  it("matches the plan example: 15", () => {
    expect(computeT([100, 100.1, 100.05, 100.2])).toBe(15);
  });

  it("is not pushed to 16 by float noise (ceil of 15.000000000000002)", () => {
    // moves 10 bp each; 1.5 * 10 = 15 exactly in integer math
    expect(computeT([100, 100.1, 100.2, 100.3])).toBe(15);
  });

  it("returns 1 for a flat series", () => {
    expect(computeT([100, 100, 100, 100])).toBe(1);
  });

  it("odd count of moves: median is the middle move", () => {
    // moves (bp): 10, 5, 15 -> median 10 -> 15
    expect(computeT([100, 100.1, 100.05, 100.2])).toBe(15);
    // moves 2 (single move): ceil(1.5 * 2) = 3
    expect(computeT([100, 100.02])).toBe(3);
    // moves 1: ceil(1.5) = 2
    expect(computeT([100, 100.01])).toBe(2);
  });

  it("even count of moves: median is the mean of the two middle moves, no premature rounding", () => {
    // moves 10, 20 -> median 15 -> 22.5 -> ceil 23
    expect(computeT([100, 100.1, 100.3])).toBe(23);
    // moves 1, 2 -> median 1.5 -> 2.25 -> ceil 3
    expect(computeT([100, 100.01, 100.03])).toBe(3);
    // moves 4, 4 -> median 4 -> 6
    expect(computeT([100, 100.04, 100.08])).toBe(6);
  });

  it("needs at least two closes and finite positive prices", () => {
    expect(() => computeT([])).toThrow();
    expect(() => computeT([100])).toThrow();
    expect(() => computeT([100, NaN])).toThrow();
    expect(() => computeT([100, 0, 100])).toThrow();
    expect(() => computeT([100, -1])).toThrow();
  });

  it("result is an integer in 1..uint32.max", () => {
    const t = computeT([100, 103, 99, 104, 98]);
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(4294967295);
  });
});
