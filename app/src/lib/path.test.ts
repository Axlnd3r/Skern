import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValid, score } from "../../../shared/score";
import {
  FLAT_HANDLES,
  bpToY,
  boundsForT,
  clampHandle,
  commitGuard,
  flatBaseline,
  handleIndex,
  handlesToPath,
  moveHandle,
  yToBp,
  type Handles,
} from "./path";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const CTX = { min: -500, max: 500 };

/** handles of 3 candles: [close, high, low] x 3 */
const h = (...v: number[]): Handles => v;

describe("handleIndex", () => {
  it("maps candle*3 + field", () => {
    expect(handleIndex(0, "close")).toBe(0);
    expect(handleIndex(0, "high")).toBe(1);
    expect(handleIndex(0, "low")).toBe(2);
    expect(handleIndex(2, "low")).toBe(8);
  });
});

describe("flat baseline", () => {
  it("flat baseline path is all zeros", () => {
    const p = flatBaseline();
    expect(p).toHaveLength(3);
    for (const c of p) expect(c).toEqual({ close: 0, high: 0, low: 0 });
    expect(isValid(p)).toBe(true);
  });

  it("flat handles map to the flat baseline", () => {
    expect(FLAT_HANDLES).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(handlesToPath(FLAT_HANDLES)).toEqual(flatBaseline());
  });

  it("the flat path scores 100 against itself", () => {
    expect(score(flatBaseline(), flatBaseline(), 100)).toBe(100);
  });
});

describe("clampHandle", () => {
  it("dragging a high below the close clamps to the close", () => {
    const hs = h(100, 120, -10, 0, 0, 0, 0, 0, 0);
    expect(clampHandle(hs, handleIndex(0, "high"), { ...CTX, value: 40 })).toBe(100);
  });

  it("dragging a high below the open clamps to the open (candle 2 open = close 1)", () => {
    const hs = h(100, 120, -10, 90, 150, 80, 0, 0, 0);
    expect(clampHandle(hs, handleIndex(1, "high"), { ...CTX, value: 10 })).toBe(100);
  });

  it("dragging a low above the close clamps to the close", () => {
    const hs = h(-50, 20, -80, 0, 0, 0, 0, 0, 0);
    expect(clampHandle(hs, handleIndex(0, "low"), { ...CTX, value: 30 })).toBe(-50);
  });

  it("dragging a low above the open (0) clamps to the open on candle 1", () => {
    const hs = h(60, 80, -20, 0, 0, 0, 0, 0, 0);
    expect(clampHandle(hs, handleIndex(0, "low"), { ...CTX, value: 30 })).toBe(0);
  });

  it("a value inside the allowed range is kept", () => {
    const hs = h(10, 50, -50, 0, 0, 0, 0, 0, 0);
    expect(clampHandle(hs, handleIndex(0, "high"), { ...CTX, value: 70 })).toBe(70);
    expect(clampHandle(hs, handleIndex(0, "low"), { ...CTX, value: -70 })).toBe(-70);
    expect(clampHandle(hs, handleIndex(0, "close"), { ...CTX, value: 33 })).toBe(33);
  });

  it("clamps to the chart bounds", () => {
    const hs = FLAT_HANDLES;
    expect(clampHandle(hs, handleIndex(0, "close"), { ...CTX, value: 9999 })).toBe(500);
    expect(clampHandle(hs, handleIndex(0, "close"), { ...CTX, value: -9999 })).toBe(-500);
    expect(clampHandle(hs, handleIndex(1, "high"), { ...CTX, value: 9999 })).toBe(500);
    expect(clampHandle(hs, handleIndex(1, "low"), { ...CTX, value: -9999 })).toBe(-500);
  });

  it("clamps to int32 even when the bounds are wider", () => {
    const wide = { min: -1e12, max: 1e12 };
    expect(clampHandle(FLAT_HANDLES, 0, { ...wide, value: 1e12 })).toBe(INT32_MAX);
    expect(clampHandle(FLAT_HANDLES, 0, { ...wide, value: -1e12 })).toBe(INT32_MIN);
  });

  it("returns integers only", () => {
    const v = clampHandle(FLAT_HANDLES, 0, { ...CTX, value: 12.6 });
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBe(13);
  });

  it("keeps the current value for a non-finite proposal", () => {
    const hs = h(7, 9, -3, 0, 0, 0, 0, 0, 0);
    expect(clampHandle(hs, 0, { ...CTX, value: Number.NaN })).toBe(7);
    expect(clampHandle(hs, 0, { ...CTX, value: Number.POSITIVE_INFINITY })).toBe(7);
  });

  it("rejects an index outside 0..8, a short handle array or inconsistent bounds", () => {
    expect(() => clampHandle(FLAT_HANDLES, 9, { ...CTX, value: 0 })).toThrow();
    expect(() => clampHandle(FLAT_HANDLES, -1, { ...CTX, value: 0 })).toThrow();
    expect(() => clampHandle(FLAT_HANDLES, 0.5, { ...CTX, value: 0 })).toThrow();
    expect(() => clampHandle([0, 0], 0, { ...CTX, value: 0 })).toThrow();
    expect(() => clampHandle(FLAT_HANDLES, 0, { min: 10, max: -10, value: 0 })).toThrow();
    expect(() => clampHandle(FLAT_HANDLES, 0, { min: 5, max: 10, value: 7 })).toThrow();
  });
});

describe("moveHandle", () => {
  it("moving a close above the next candle's high widens that candle so the path stays valid", () => {
    // candle 2 spans [-10, 20] around open 0; moving close 1 to 300 makes its open 300
    const hs = h(0, 10, -10, 0, 20, -10, 0, 0, 0);
    const next = moveHandle(hs, handleIndex(0, "close"), { ...CTX, value: 300 });
    expect(next[0]).toBe(300);
    expect(isValid(handlesToPath(next))).toBe(true);
    // candle 1 high follows the close, candle 2 high follows its new open
    expect(next[1]).toBeGreaterThanOrEqual(300);
    expect(next[4]).toBeGreaterThanOrEqual(300);
  });

  it("moving a close below the neighbours widens the lows", () => {
    const hs = h(0, 10, -10, 0, 20, -10, 0, 5, -5);
    const next = moveHandle(hs, handleIndex(0, "close"), { ...CTX, value: -400 });
    const p = handlesToPath(next);
    expect(isValid(p)).toBe(true);
    expect(p[0].low).toBeLessThanOrEqual(-400);
    expect(p[1].low).toBeLessThanOrEqual(-400);
  });

  it("moving a high or low only changes that handle", () => {
    const hs = h(10, 50, -50, 0, 50, -50, 0, 0, 0);
    const next = moveHandle(hs, handleIndex(0, "high"), { ...CTX, value: 80 });
    expect(next).toEqual([10, 80, -50, 0, 50, -50, 0, 0, 0]);
  });

  it("does not mutate its input", () => {
    const hs = h(10, 50, -50, 0, 0, 0, 0, 0, 0);
    const copy = [...hs];
    moveHandle(hs, 0, { ...CTX, value: 400 });
    expect(hs).toEqual(copy);
  });
});

describe("handlesToPath", () => {
  it("maps the 9 handles to 3 candles in close/high/low order", () => {
    const p = handlesToPath(h(10, 20, -5, 15, 30, 0, 5, 40, -9));
    expect(p).toEqual([
      { close: 10, high: 20, low: -5 },
      { close: 15, high: 30, low: 0 },
      { close: 5, high: 40, low: -9 },
    ]);
  });

  it("repairs invalid raw handles instead of emitting an invalid path", () => {
    // high below close, low above open on every candle
    const p = handlesToPath(h(100, 5, 50, -40, -60, 30, 0, -9, 9));
    expect(isValid(p)).toBe(true);
  });

  it("outputs integers only, normalizing fractions, NaN and negative zero", () => {
    const p = handlesToPath(h(1.4, 3.6, -0.2, Number.NaN, 0, -0, 0, 0, 0));
    for (const c of p) {
      for (const v of [c.close, c.high, c.low]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(Object.is(v, -0)).toBe(false);
      }
    }
    expect(isValid(p)).toBe(true);
  });

  it("clamps to int32", () => {
    const p = handlesToPath(h(1e12, 1e12, -1e12, -1e12, 1e12, -1e12, 0, 0, 0));
    for (const c of p) {
      for (const v of [c.close, c.high, c.low]) {
        expect(v).toBeGreaterThanOrEqual(INT32_MIN);
        expect(v).toBeLessThanOrEqual(INT32_MAX);
      }
    }
    expect(isValid(p)).toBe(true);
  });

  it("rejects a handle array that is not 9 long", () => {
    expect(() => handlesToPath([0, 0, 0])).toThrow();
    expect(() => handlesToPath(new Array(10).fill(0))).toThrow();
  });

  it("handlesToPath output always passes isValid (arbitrary raw handles)", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ noDefaultInfinity: false }), { minLength: 9, maxLength: 9 }), (raw) => {
        expect(isValid(handlesToPath(raw))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("handlesToPath output always passes isValid (arbitrary drag sequences)", () => {
    const drag = fc.record({
      index: fc.integer({ min: 0, max: 8 }),
      value: fc.oneof(fc.integer({ min: -1200, max: 1200 }), fc.double({ noNaN: false })),
    });
    fc.assert(
      fc.property(fc.array(drag, { maxLength: 60 }), (drags) => {
        let hs: Handles = FLAT_HANDLES;
        for (const d of drags) {
          hs = moveHandle(hs, d.index, { ...CTX, value: d.value });
          // every intermediate state is valid and untouched by handlesToPath's repair
          const p = handlesToPath(hs);
          expect(isValid(p)).toBe(true);
          expect([p[0].close, p[0].high, p[0].low, p[1].close, p[1].high, p[1].low, p[2].close, p[2].high, p[2].low]).toEqual(hs);
          for (const v of hs) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(CTX.min);
            expect(v).toBeLessThanOrEqual(CTX.max);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a valid path also scores 0..100 against the flat baseline", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 9, maxLength: 9 }), (raw) => {
        const s = score(handlesToPath(raw), flatBaseline(), 100);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe("boundsForT", () => {
  it("is 5 * T, at least 1 and within int32", () => {
    expect(boundsForT(100)).toBe(500);
    expect(boundsForT(0)).toBe(1);
    expect(boundsForT(4_000_000_000)).toBe(INT32_MAX);
  });
});

describe("screen geometry (display only)", () => {
  it("maps bp to y and back", () => {
    expect(bpToY(0, 300, 500)).toBe(150);
    expect(bpToY(500, 300, 500)).toBe(0);
    expect(bpToY(-500, 300, 500)).toBe(300);
    expect(yToBp(150, 300, 500)).toBe(0);
    expect(yToBp(0, 300, 500)).toBe(500);
    expect(yToBp(300, 300, 500)).toBe(-500);
    expect(Number.isInteger(yToBp(123.456, 300, 500))).toBe(true);
  });
});

describe("commitGuard", () => {
  const ok = { path: flatBaseline(), phase: "commit" as const, closing: false, simulated: false, connected: true };

  it("allows a valid path in the commit phase, outside closing", () => {
    expect(commitGuard(ok)).toEqual({ ok: true });
  });

  it("blocks an invalid path", () => {
    const bad = [{ close: 5, high: 1, low: 0 }, ok.path[1], ok.path[2]] as const;
    const g = commitGuard({ ...ok, path: bad });
    expect(g.ok).toBe(false);
  });

  it("blocks every phase other than commit", () => {
    for (const phase of ["reveal", "market", "play", "settled", "void"] as const) {
      expect(commitGuard({ ...ok, phase }).ok).toBe(false);
    }
  });

  it("blocks while the commit window is closing", () => {
    expect(commitGuard({ ...ok, closing: true }).ok).toBe(false);
  });

  it("blocks practice (simulated) rounds and a disconnected wallet", () => {
    expect(commitGuard({ ...ok, simulated: true }).ok).toBe(false);
    expect(commitGuard({ ...ok, connected: false }).ok).toBe(false);
  });

  it("gives a reason when blocked", () => {
    const g = commitGuard({ ...ok, closing: true });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason.length).toBeGreaterThan(0);
  });
});
