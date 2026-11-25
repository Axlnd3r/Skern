import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { impliedOdds, projectedPayout } from "./odds";

describe("impliedOdds", () => {
  it("odds with equal pools are 0.5/0.5", () => {
    expect(impliedOdds(100n, 100n)).toEqual({ human: 0.5, agent: 0.5 });
    expect(impliedOdds(1n, 1n)).toEqual({ human: 0.5, agent: 0.5 });
  });

  it("odds with empty pools do not divide by zero", () => {
    const o = impliedOdds(0n, 0n);
    expect(o).toEqual({ human: 0.5, agent: 0.5 });
    expect(Number.isFinite(o.human) && Number.isFinite(o.agent)).toBe(true);
  });

  it("a one-sided pool gives that side all of the weight", () => {
    expect(impliedOdds(50n, 0n)).toEqual({ human: 1, agent: 0 });
    expect(impliedOdds(0n, 50n)).toEqual({ human: 0, agent: 1 });
  });

  it("is proportional to the pools", () => {
    const o = impliedOdds(30n, 70n);
    expect(o.human).toBeCloseTo(0.3, 6);
    expect(o.agent).toBeCloseTo(0.7, 6);
  });

  it("handles pools far beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 2n ** 200n;
    expect(impliedOdds(big, big)).toEqual({ human: 0.5, agent: 0.5 });
    const o = impliedOdds(big, 3n * big);
    expect(o.human).toBeCloseTo(0.25, 6);
  });

  it("treats a negative (malformed) pool as empty", () => {
    expect(impliedOdds(-5n, 10n)).toEqual({ human: 0, agent: 1 });
    expect(impliedOdds(-5n, -5n)).toEqual({ human: 0.5, agent: 0.5 });
  });

  it("always returns two probabilities in [0, 1] that sum to 1", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), (h, a) => {
        const o = impliedOdds(h, a);
        expect(o.human).toBeGreaterThanOrEqual(0);
        expect(o.human).toBeLessThanOrEqual(1);
        expect(o.human + o.agent).toBe(1);
      }),
    );
  });
});

describe("projectedPayout", () => {
  it("mirrors the contract floor formula stake * total / winnerPool, including the new bet", () => {
    // 100 on a side already holding 100 of 300: after the bet, side 200, total 400 -> 100 * 400 / 200.
    expect(projectedPayout(100n, 100n, 300n)).toBe(200n);
    // floor: 10 * 25 / 12 = 20.83 -> 20
    expect(projectedPayout(10n, 2n, 15n)).toBe(20n);
  });
  it("returns 0 for a zero amount and never divides by zero", () => {
    expect(projectedPayout(0n, 0n, 0n)).toBe(0n);
    expect(projectedPayout(5n, 0n, 0n)).toBe(5n);
  });
});
