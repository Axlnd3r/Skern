import { describe, expect, it } from "vitest";
import { handleLabel } from "./chartLabels";

const R = 8;
const H = 320;

describe("handleLabel", () => {
  it("leans high up-left, close up-right and low down-right", () => {
    const high = handleLabel("high", 182, 160, R, H);
    const close = handleLabel("close", 200, 160, R, H);
    const low = handleLabel("low", 218, 160, R, H);
    expect(high.tx).toBeLessThan(182);
    expect(high.ty).toBeLessThan(160);
    expect(high.anchor).toBe("end");
    expect(close.tx).toBeGreaterThan(200);
    expect(close.ty).toBeLessThan(160);
    expect(close.anchor).toBe("start");
    expect(low.tx).toBeGreaterThan(218);
    expect(low.ty).toBeGreaterThan(160);
  });

  it("keeps the three labels of the flat state apart horizontally or vertically", () => {
    const [h, c, l] = [handleLabel("high", 182, 160, R, H), handleLabel("close", 200, 160, R, H), handleLabel("low", 218, 160, R, H)];
    // high is left of every x of close and low (it is end-anchored); close and low are far apart vertically
    expect(h.tx).toBeLessThan(c.tx);
    expect(Math.abs(c.ty - l.ty)).toBeGreaterThan(20);
  });

  it("clamps the label into the picture at the range limits", () => {
    expect(handleLabel("high", 182, 16, R, H).ty).toBeGreaterThanOrEqual(14);
    expect(handleLabel("low", 218, 304, R, H).ty).toBeLessThanOrEqual(H - 26);
  });

  it("starts the leader on the handle's rim and ends before the text, with finite numbers", () => {
    for (const f of ["high", "close", "low"] as const) {
      const l = handleLabel(f, 200, 100, R, H);
      expect(Math.hypot(l.x1 - 200, l.y1 - 100)).toBeCloseTo(R + 2, 5);
      for (const v of [l.x1, l.y1, l.x2, l.y2, l.tx, l.ty]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(l.x2 - l.tx)).toBe(4);
    }
  });
});
