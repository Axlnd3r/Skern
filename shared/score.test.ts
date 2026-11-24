import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValid, score, type Candle, type Path } from "./score";

interface Vector {
  name: string;
  T: number;
  pred: Path;
  real: Path;
  predValid: boolean;
  realValid: boolean;
  score: number;
}

const raw = readFileSync(new URL("../contracts/test/vectors/score.json", import.meta.url), "utf8");
const vectors: Vector[] = (JSON.parse(raw) as { vectors: Vector[] }).vectors;

describe("score parity with ScoreLib.sol", () => {
  it("has enough vectors, including negatives, extremes and invalid paths", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    const fields = vectors.flatMap((v) => [...v.pred, ...v.real]).flatMap((c: Candle) => [c.close, c.high, c.low]);
    expect(fields.some((x) => x < 0)).toBe(true);
    expect(fields).toContain(2147483647);
    expect(fields).toContain(-2147483648);
    expect(vectors.some((v) => !v.predValid)).toBe(true);
    expect(vectors.some((v) => v.T === 1)).toBe(true);
    expect(vectors.some((v) => v.T === 4294967295)).toBe(true);
  });

  for (const v of vectors) {
    it(`${v.name} (T=${v.T})`, () => {
      expect(score(v.pred, v.real, v.T)).toBe(v.score);
      expect(isValid(v.pred)).toBe(v.predValid);
      expect(isValid(v.real)).toBe(v.realValid);
    });
  }

  it("rejects T = 0 like ScoreLib", () => {
    const p = vectors[0]!.pred;
    expect(() => score(p, p, 0)).toThrow();
  });

  it("rejects T outside uint32 and non-integer T", () => {
    const p = vectors[0]!.pred;
    expect(() => score(p, p, 4294967296)).toThrow();
    expect(() => score(p, p, -1)).toThrow();
    expect(() => score(p, p, 1.5)).toThrow();
  });

  it("rejects a non-3-length path", () => {
    const p = vectors[0]!.pred;
    const bad = [[], [p[0], p[1]], [p[0], p[1], p[2], p[0]]] as unknown as Path[];
    for (const b of bad) {
      expect(isValid(b)).toBe(false);
      expect(() => score(b, p, 20)).toThrow();
      expect(() => score(p, b, 20)).toThrow();
    }
  });
});

// Expected values below are hand-derived and independent of the generator / score.json.
const c = (close: number, high: number, low: number): Candle => ({ close, high, low });
const realPath = (): Path => [c(10, 12, -2), c(20, 22, 8), c(30, 32, 18)];
const flatPath = (): Path => [c(0, 0, 0), c(0, 0, 0), c(0, 0, 0)];

describe("named expected scores (independent of score.json)", () => {
  it("perfect path = 100", () => {
    expect(score(realPath(), realPath(), 20)).toBe(100);
  });

  it("flat baseline = 29", () => {
    // per-candle s = 53000, 20000, 15000 -> 88000 * 100 / 300000 = 29
    expect(score(flatPath(), realPath(), 20)).toBe(29);
  });

  it("T=1 one bp high error = 96", () => {
    // candle 1 pred high 13 vs real 12: R = 10000 - 1*10000/2 = 5000, s1 = 90000 -> 290000*100/300000 = 96
    const pred: Path = [c(10, 13, -2), c(20, 22, 8), c(30, 32, 18)];
    const real = realPath();
    expect(score(pred, real, 1)).toBe(96);
    expect(real[0].high).toBe(12);
  });
});

describe("isValid: each clause in isolation (all other candles valid)", () => {
  const rest2 = c(20, 22, -10); // opens at -10 after a down candle 1
  const rest3 = c(30, 32, 18);
  it("accepts the reference path and inclusive boundaries", () => {
    expect(isValid(realPath())).toBe(true);
    expect(isValid(flatPath())).toBe(true);
    expect(isValid([c(10, 10, 0), c(20, 20, 10), c(5, 20, 5)])).toBe(true);
    expect(isValid([c(-10, 0, -10), rest2, rest3])).toBe(true);
  });
  it("low > open only", () => {
    expect(isValid([c(10, 12, 5), c(20, 22, 8), rest3])).toBe(false);
  });
  it("low > close only (down candle)", () => {
    expect(isValid([c(-10, 0, -5), rest2, rest3])).toBe(false);
  });
  it("high < open only (down candle)", () => {
    expect(isValid([c(-10, -1, -10), rest2, rest3])).toBe(false);
  });
  it("high < close only (up candle)", () => {
    expect(isValid([c(10, 8, 0), c(20, 22, 8), rest3])).toBe(false);
  });
  it("same four violations in candle 3 (open = candle 2 close = 20)", () => {
    const head: [Candle, Candle] = [c(10, 12, -2), c(20, 22, 8)];
    expect(isValid([...head, c(30, 32, 25)])).toBe(false); // low > open
    expect(isValid([...head, c(5, 20, 10)])).toBe(false); // low > close
    expect(isValid([...head, c(5, 19, 0)])).toBe(false); // high < open
    expect(isValid([...head, c(30, 29, 18)])).toBe(false); // high < close
  });
});

describe("runtime hardening", () => {
  const MAX = 2147483647;
  const MIN = -2147483648;
  // valid flat-at-extreme paths: candle 1 opens at 0 and moves to the extreme, then stays there
  const maxPath: Path = [c(MAX, MAX, 0), c(MAX, MAX, MAX), c(MAX, MAX, MAX)];
  const minPath: Path = [c(MIN, 0, MIN), c(MIN, MIN, MIN), c(MIN, MIN, MIN)];

  it("isValid rejects empty, 2 and 4 candles", () => {
    expect(isValid([] as unknown as Path)).toBe(false);
    expect(isValid([c(0, 0, 0), c(0, 0, 0)] as unknown as Path)).toBe(false);
    expect(isValid([c(0, 0, 0), c(0, 0, 0), c(0, 0, 0), c(0, 0, 0)] as unknown as Path)).toBe(false);
  });

  it("score throws on empty, 2 and 4 candles", () => {
    const ok = flatPath();
    expect(() => score([] as unknown as Path, ok, 1)).toThrow();
    expect(() => score(ok, [c(0, 0, 0), c(0, 0, 0)] as unknown as Path, 1)).toThrow();
    expect(() => score([...ok, c(0, 0, 0)] as unknown as Path, ok, 1)).toThrow();
  });

  it("rejects fields outside int32", () => {
    // close = 2^31 and -2^31 - 1 (high/low chosen so geometry alone would be valid)
    const over: Path = [c(MAX + 1, MAX + 1, 0), c(MAX + 1, MAX + 1, 0), c(MAX + 1, MAX + 1, 0)];
    const under: Path = [c(MIN - 1, 0, MIN - 1), c(MIN - 1, 0, MIN - 1), c(MIN - 1, 0, MIN - 1)];
    expect(isValid(over)).toBe(false);
    expect(isValid(under)).toBe(false);
    expect(() => score(over, flatPath(), 1)).toThrow();
    expect(() => score(flatPath(), under, 1)).toThrow();
    // out-of-range high and low alone
    expect(isValid([c(0, MAX + 1, 0), c(0, 0, 0), c(0, 0, 0)])).toBe(false);
    expect(isValid([c(0, 0, MIN - 1), c(0, 0, 0), c(0, 0, 0)])).toBe(false);
  });

  it("rejects non-integer and NaN fields", () => {
    expect(isValid([c(1.5, 2, 0), c(1.5, 2, 0), c(1.5, 2, 0)])).toBe(false);
    expect(isValid([c(Number.NaN, 0, 0), c(0, 0, 0), c(0, 0, 0)])).toBe(false);
    expect(() => score([c(1.5, 2, 0), c(1.5, 2, 0), c(1.5, 2, 0)], flatPath(), 1)).toThrow();
  });

  it("accepts the int32 boundary values 2^31-1 and -2^31", () => {
    expect(isValid(maxPath)).toBe(true);
    expect(isValid(minPath)).toBe(true);
    expect(isValid([c(MAX, MAX, 0), c(MIN, MAX, MIN), c(MAX, MAX, MIN)])).toBe(true);
    // C = R = 0; D: candle 1 opposite (0), candles 2 and 3 both flat (10000 each) -> 60000 -> 20 (as in Solidity)
    expect(score(maxPath, minPath, 1)).toBe(20);
    expect(score(minPath, maxPath, 1)).toBe(20);
    expect(score(maxPath, maxPath, 1)).toBe(100);
    expect(score(minPath, minPath, 4294967295)).toBe(100);
  });

  it("returns false (not a TypeError) for holey arrays", () => {
    const z: Candle = { close: 0, high: 0, low: 0 };
    expect(isValid(new Array(3) as unknown as Path)).toBe(false);
    expect(isValid([z, , z] as unknown as Path)).toBe(false);
    expect(isValid([, z, z] as unknown as Path)).toBe(false);
    // a real hole at index 2 (a trailing-comma literal would only be length 2)
    const hole2 = [z, z, z];
    delete hole2[2];
    expect(hole2.length).toBe(3);
    expect(isValid(hole2 as unknown as Path)).toBe(false);
    expect(isValid(Object.assign(new Array(3), { 0: z, 1: z }) as unknown as Path)).toBe(false);
    expect(isValid(Object.assign(new Array(3), { 1: z, 2: z }) as unknown as Path)).toBe(false);
    expect(isValid(Object.assign(new Array(3), { 0: z, 2: z }) as unknown as Path)).toBe(false);
    expect(isValid([z, z, z] as unknown as Path)).toBe(true);
    expect(() => score(new Array(3) as unknown as Path, vectors[0]!.real, 20)).toThrow();
  });
});

