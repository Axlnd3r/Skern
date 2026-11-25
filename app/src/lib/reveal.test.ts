import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValid, score, type Path } from "../../../shared/score";
import { handlesToPath } from "./path";
import {
  STEP_COUNT,
  deriveReveal,
  fitBound,
  nextStep,
  outcomeLine,
  parseRevealReads,
  parseRealCandles,
  parseScores,
  revealFrame,
  scoresAgree,
} from "./reveal";

const T = 100;
const REAL: Path = [
  { close: 40, high: 70, low: -5 },
  { close: 10, high: 50, low: 0 },
  { close: 60, high: 85, low: 5 },
];
const HUMAN: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];
const AGENT: Path = [
  { close: 30, high: 60, low: 0 },
  { close: 0, high: 40, low: -10 },
  { close: 50, high: 70, low: -20 },
];
const IN = { real: REAL, human: HUMAN, agent: AGENT, T };

describe("revealFrame", () => {
  it("shows candle n only after n steps", () => {
    for (let n = 0; n <= STEP_COUNT; n++) {
      const f = revealFrame(IN, n);
      expect(f.real).toHaveLength(n);
      expect(f.real).toEqual(REAL.slice(0, n));
      expect(f.done).toBe(n === STEP_COUNT);
    }
  });

  it("clamps out-of-range and non-integer steps", () => {
    expect(revealFrame(IN, -3).real).toHaveLength(0);
    expect(revealFrame(IN, 99).real).toHaveLength(3);
    expect(revealFrame(IN, 1.9).real).toHaveLength(1);
    expect(revealFrame(IN, NaN).real).toHaveLength(0);
  });

  it("shows no score before the first candle and the exact shared score after the last", () => {
    const f0 = revealFrame(IN, 0);
    expect(f0.humanScore).toBeNull();
    expect(f0.agentScore).toBeNull();
    const f3 = revealFrame(IN, 3);
    expect(f3.humanScore).toBe(score(HUMAN, REAL, T));
    expect(f3.agentScore).toBe(score(AGENT, REAL, T));
  });

  it("a missing consensus side has no score", () => {
    const f = revealFrame({ ...IN, agent: null }, 2);
    expect(f.humanScore).not.toBeNull();
    expect(f.agentScore).toBeNull();
  });

  it("the live score at step n never depends on real candles that are not yet revealed", () => {
    const other: Path = [
      { close: -200, high: 10, low: -300 },
      { close: 300, high: 400, low: -250 },
      { close: -50, high: 20, low: -90 },
    ];
    for (let n = 0; n < STEP_COUNT; n++) {
      const mixed = [...REAL.slice(0, n), ...other.slice(n)] as unknown as Path;
      const a = revealFrame(IN, n);
      const b = revealFrame({ ...IN, real: mixed }, n);
      expect(b.real).toEqual(a.real);
      expect(b.humanScore).toBe(a.humanScore);
      expect(b.agentScore).toBe(a.agentScore);
    }
  });

  it("a perfect prediction scores 100 at every step", () => {
    for (let n = 1; n <= 3; n++) {
      expect(revealFrame({ real: REAL, human: REAL, agent: null, T }, n).humanScore).toBe(100);
    }
  });

  it("is deterministic: the same inputs give identical frames (faithful replay)", () => {
    const a = [0, 1, 2, 3].map((n) => revealFrame(IN, n));
    const b = [0, 1, 2, 3].map((n) => revealFrame(IN, n));
    expect(b).toEqual(a);
  });

  it("scores stay integers within 0..100 for any valid paths (property)", () => {
    const handles = fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 9, maxLength: 9 });
    fc.assert(
      fc.property(handles, handles, handles, fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 3 }), (r, h, a, t, n) => {
        const f = revealFrame({ real: handlesToPath(r), human: handlesToPath(h), agent: handlesToPath(a), T: t }, n);
        for (const s of [f.humanScore, f.agentScore]) {
          if (n === 0) expect(s).toBeNull();
          else {
            expect(Number.isInteger(s)).toBe(true);
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(100);
          }
        }
      }),
    );
  });
});

describe("nextStep", () => {
  it("advances one step and stops at the last candle", () => {
    expect(nextStep(0)).toBe(1);
    expect(nextStep(2)).toBe(3);
    expect(nextStep(3)).toBe(3);
  });
});

describe("parseRealCandles (untrusted chain data)", () => {
  const hash = "0x" + "ab".repeat(32);
  it("accepts [real, sourceHash]", () => {
    expect(parseRealCandles([REAL, hash])).toEqual({ real: REAL, sourceHash: hash });
  });
  it("rejects malformed input and invalid candles", () => {
    expect(parseRealCandles(undefined)).toBeNull();
    expect(parseRealCandles([REAL])).toBeNull();
    expect(parseRealCandles([REAL, "0x12"])).toBeNull();
    expect(parseRealCandles([[REAL[0], REAL[1]], hash])).toBeNull();
    expect(parseRealCandles([[REAL[0], REAL[1], { close: 5, high: 1, low: 0 }], hash])).toBeNull();
    const parsed = parseRealCandles([REAL, hash]);
    expect(parsed !== null && isValid(parsed.real)).toBe(true);
  });
});

describe("parseScores", () => {
  it("accepts integers 0..100 and flags", () => {
    expect(parseScores([60, 55, true, false])).toEqual({ human: 60, agent: 55, humanPresent: true, agentPresent: false });
  });
  it("rejects anything else", () => {
    expect(parseScores([101, 5, true, true])).toBeNull();
    expect(parseScores([-1, 5, true, true])).toBeNull();
    expect(parseScores([1.5, 5, true, true])).toBeNull();
    expect(parseScores([1n, 5, true, true])).toBeNull();
    expect(parseScores([1, 5, 1, true])).toBeNull();
    expect(parseScores([1, 5, true])).toBeNull();
    expect(parseScores(null)).toBeNull();
  });
});

describe("scoresAgree", () => {
  it("compares the local replay with the on-chain consensus scores for present sides only", () => {
    const h = score(HUMAN, REAL, T);
    const a = score(AGENT, REAL, T);
    const chain = { human: h, agent: a, humanPresent: true, agentPresent: true };
    expect(scoresAgree({ humanScore: h, agentScore: a }, chain)).toBe(true);
    expect(scoresAgree({ humanScore: h + 1, agentScore: a }, chain)).toBe(false);
    expect(scoresAgree({ humanScore: h, agentScore: null }, { ...chain, agentPresent: false })).toBe(true);
    expect(scoresAgree({ humanScore: h, agentScore: null }, chain)).toBe(false);
  });
});

describe("fitBound", () => {
  it("covers every field of every path and at least T", () => {
    const b = fitBound([REAL, HUMAN], T);
    expect(b).toBeGreaterThanOrEqual(T);
    expect(b).toBeGreaterThanOrEqual(90);
    const wide: Path = [{ close: 0, high: 0, low: -5000 }, REAL[1], REAL[2]];
    expect(fitBound([wide], T)).toBeGreaterThan(5000);
  });
  it("is a positive integer even with no paths", () => {
    expect(fitBound([], 0)).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(fitBound([], 100))).toBe(true);
  });
});

describe("deriveReveal", () => {
  const ready = { real: REAL, sourceHash: "0x" + "00".repeat(32), human: HUMAN, agent: AGENT };
  it("is honest about phases before candles exist", () => {
    for (const phase of ["commit", "reveal", "market"] as const) {
      expect(deriveReveal({ phase, reads: undefined }).state).toBe("waiting");
    }
    expect(deriveReveal({ phase: "play", reads: undefined }).state).toBe("pending");
  });
  it("shows void without reading any score", () => {
    const v = deriveReveal({ phase: "void", reads: undefined });
    expect(v.state).toBe("void");
    expect(v.message).toMatch(/not settle|void/i);
  });
  it("is loading while a settled round's reads are in flight, error when they failed", () => {
    expect(deriveReveal({ phase: "settled", reads: undefined }).state).toBe("loading");
    expect(deriveReveal({ phase: "settled", reads: null }).state).toBe("error");
  });
  it("is ready with the parsed reads", () => {
    const v = deriveReveal({ phase: "settled", reads: ready });
    expect(v.state).toBe("ready");
  });
});

describe("outcomeLine", () => {
  it("names the higher side, a tie, or a missing side", () => {
    expect(outcomeLine(62, 55)).toMatch(/Human consensus scored higher/);
    expect(outcomeLine(40, 55)).toMatch(/Agent consensus scored higher/);
    expect(outcomeLine(50, 50)).toMatch(/Tie/);
    expect(outcomeLine(50, null)).toMatch(/no Human versus Agent/);
  });
});

describe("parseRevealReads (untrusted chain data)", () => {
  const hash = "0x" + "cd".repeat(32);
  const OK = (result: unknown) => ({ status: "success", result });
  const FAIL = { status: "failure", error: new Error("revert") };
  const all = [OK([REAL, hash]), OK([HUMAN, true]), OK([AGENT, true]), OK([60, 55, true, true]), OK(12)];

  it("parses a full result", () => {
    expect(parseRevealReads(all)).toEqual({
      real: REAL,
      sourceHash: hash,
      human: HUMAN,
      agent: AGENT,
      scores: { human: 60, agent: 55, humanPresent: true, agentPresent: true },
      baseline: 12,
    });
  });
  it("needs the real candles; everything else degrades", () => {
    expect(parseRevealReads([FAIL, ...all.slice(1)])).toBeNull();
    expect(parseRevealReads([OK([REAL, "0x1"]), ...all.slice(1)])).toBeNull();
    expect(parseRevealReads(all.slice(0, 4))).toBeNull();
    const d = parseRevealReads([all[0], FAIL, OK([AGENT, true]), FAIL, OK(1000)]);
    expect(d).toEqual({ real: REAL, sourceHash: hash, human: null, agent: AGENT });
  });
  it("never uses a consensus path that is not ready", () => {
    const d = parseRevealReads([all[0], OK([HUMAN, false]), all[2], all[3], all[4]]);
    expect(d?.human).toBeNull();
  });
});
