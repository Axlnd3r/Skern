import { describe, expect, it } from "vitest";
import {
  CLOSING_THRESHOLD_SEC,
  actionFor,
  countdownAt,
  deriveRound,
  isClosing,
  formatCountdown,
  parseRoundParams,
  parseStatus,
  phaseAt,
  tickerLabel,
  type RoundParams,
} from "./round";

const params: RoundParams = {
  ticker: `0x${Buffer.from("NVDA").toString("hex").padEnd(64, "0")}`,
  p0: 1_000_000n,
  T: 100,
  commitEnd: 1_000n,
  revealEnd: 2_000n,
  marketEnd: 3_000n,
  candleSec: 300,
  settleDeadline: 10_000n,
  entryStake: 10n,
};
// first moment candles may be posted: marketEnd + 3 * candleSec
const playEnd = 3_000n + 3n * 300n;

describe("phaseAt boundaries (block-time based)", () => {
  it("is commit strictly before commitEnd", () => {
    expect(phaseAt(params, 0n)).toBe("commit");
    expect(phaseAt(params, 999n)).toBe("commit");
  });
  it("switches to reveal exactly at commitEnd", () => {
    expect(phaseAt(params, 1_000n)).toBe("reveal");
    expect(phaseAt(params, 1_999n)).toBe("reveal");
  });
  it("switches to market exactly at revealEnd", () => {
    expect(phaseAt(params, 2_000n)).toBe("market");
    expect(phaseAt(params, 2_999n)).toBe("market");
  });
  it("switches to play exactly at marketEnd and stays until settled or void", () => {
    expect(phaseAt(params, 3_000n)).toBe("play");
    expect(phaseAt(params, playEnd)).toBe("play");
    expect(phaseAt(params, 9_999n)).toBe("play");
  });
  it("is settled once the contract reports settled, whatever the clock says", () => {
    expect(phaseAt(params, playEnd, { settled: true, isVoid: false })).toBe("settled");
    expect(phaseAt(params, 0n, { settled: true, isVoid: false })).toBe("settled");
  });
  it("is void when the contract's isVoid() is true, taking precedence", () => {
    expect(phaseAt(params, 10_001n, { settled: false, isVoid: true })).toBe("void");
    expect(phaseAt(params, 500n, { settled: false, isVoid: true })).toBe("void");
    expect(phaseAt(params, 10_001n, { settled: true, isVoid: true })).toBe("void");
  });
  it("does not derive void from the clock alone (the isVoid view is authoritative)", () => {
    expect(phaseAt(params, 10_001n)).toBe("play");
  });
});

describe("countdownAt", () => {
  it("counts down to the next boundary of each phase", () => {
    expect(countdownAt(params, 400n, "commit")).toBe(600);
    expect(countdownAt(params, 1_500n, "reveal")).toBe(500);
    expect(countdownAt(params, 2_500n, "market")).toBe(500);
    expect(countdownAt(params, 3_100n, "play")).toBe(Number(playEnd - 3_100n));
  });
  it("is 0 in terminal phases and never negative", () => {
    expect(countdownAt(params, 5_000n, "settled")).toBe(0);
    expect(countdownAt(params, 5_000n, "void")).toBe(0);
    expect(countdownAt(params, 5_000n, "play")).toBe(0);
  });
});

describe("tickerLabel", () => {
  it("decodes a bytes32 ticker and strips padding", () => {
    const hex = `0x${Buffer.from("NVDA").toString("hex").padEnd(64, "0")}` as const;
    expect(tickerLabel(hex)).toBe("NVDA");
  });
  it("drops characters outside a safe set (chain data is untrusted)", () => {
    const hex = `0x${Buffer.from("<b>TS LA</b>").toString("hex").padEnd(64, "0")}` as const;
    expect(tickerLabel(hex)).toBe("bTSLAb");
  });
  it("returns a placeholder for an empty ticker", () => {
    expect(tickerLabel(`0x${"00".repeat(32)}`)).toBe("?");
  });
});

describe("parseRoundParams (untrusted chain data)", () => {
  const raw = { ...params };
  it("accepts a well-formed tuple", () => {
    expect(parseRoundParams(raw)).toEqual(params);
  });
  it("rejects non-objects and wrong types", () => {
    expect(parseRoundParams(null)).toBeNull();
    expect(parseRoundParams({ ...raw, commitEnd: 1000 })).toBeNull();
    expect(parseRoundParams({ ...raw, candleSec: 0 })).toBeNull();
  });
  it("rejects inconsistent timing", () => {
    expect(parseRoundParams({ ...raw, revealEnd: 500n })).toBeNull();
    expect(parseRoundParams({ ...raw, settleDeadline: playEnd })).toBeNull();
  });
});

describe("actionFor", () => {
  it("maps each phase to an action", () => {
    expect(actionFor("commit").label).toMatch(/draw/i);
    expect(actionFor("reveal").label).toMatch(/reveal/i);
    expect(actionFor("market").label).toMatch(/market|bet/i);
    expect(actionFor("play").label).toMatch(/watch/i);
    expect(actionFor("settled").label).toMatch(/result/i);
    expect(actionFor("void").label).toMatch(/refund|claim/i);
  });
});

describe("formatCountdown", () => {
  it("formats minutes and hours", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(3725)).toBe("1:02:05");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("parseRoundParams rejects each invalid field (mutant killers)", () => {
  const base = { ...params };
  it("requires revealEnd < marketEnd strictly", () => {
    expect(parseRoundParams({ ...base, marketEnd: base.revealEnd })).toBeNull();
    expect(parseRoundParams({ ...base, marketEnd: base.revealEnd - 1n })).toBeNull();
    expect(parseRoundParams({ ...base, marketEnd: base.revealEnd + 1n })).not.toBeNull();
  });
  it("requires commitEnd < revealEnd strictly", () => {
    expect(parseRoundParams({ ...base, revealEnd: base.commitEnd })).toBeNull();
    expect(parseRoundParams({ ...base, revealEnd: base.commitEnd + 1n, marketEnd: base.commitEnd + 2n })).not.toBeNull();
  });
  it("requires settleDeadline > marketEnd + 3 * candleSec strictly", () => {
    expect(parseRoundParams({ ...base, settleDeadline: playEnd })).toBeNull();
    expect(parseRoundParams({ ...base, settleDeadline: playEnd + 1n })).not.toBeNull();
  });
  it("rejects T = 0 and T beyond uint32", () => {
    expect(parseRoundParams({ ...base, T: 0 })).toBeNull();
    expect(parseRoundParams({ ...base, T: 2 ** 32 })).toBeNull();
    expect(parseRoundParams({ ...base, T: 0xffffffff })).not.toBeNull();
    expect(parseRoundParams({ ...base, T: -1 })).toBeNull();
    expect(parseRoundParams({ ...base, T: 1.5 })).toBeNull();
  });
  it("rejects candleSec beyond uint32", () => {
    expect(parseRoundParams({ ...base, candleSec: 2 ** 32 })).toBeNull();
  });
  it("rejects a malformed ticker", () => {
    expect(parseRoundParams({ ...base, ticker: "0x1234" })).toBeNull();
    expect(parseRoundParams({ ...base, ticker: `0x${"zz".repeat(32)}` })).toBeNull();
    expect(parseRoundParams({ ...base, ticker: `${"00".repeat(32)}` })).toBeNull();
    expect(parseRoundParams({ ...base, ticker: 123n })).toBeNull();
  });
  it("rejects non-bigint p0 and entryStake", () => {
    expect(parseRoundParams({ ...base, p0: 1 })).toBeNull();
    expect(parseRoundParams({ ...base, entryStake: "10" })).toBeNull();
  });
});

describe("parseStatus", () => {
  it("accepts two booleans", () => {
    expect(parseStatus(true, false)).toEqual({ settled: true, isVoid: false });
  });
  it("rejects anything that is not a boolean", () => {
    expect(parseStatus(1, false)).toBeNull();
    expect(parseStatus(true, "false")).toBeNull();
    expect(parseStatus(undefined, undefined)).toBeNull();
    expect(parseStatus(null, true)).toBeNull();
  });
});

describe("isClosing", () => {
  it("is true at or below the threshold in timed phases", () => {
    for (const ph of ["commit", "reveal", "market"] as const) {
      expect(isClosing(ph, CLOSING_THRESHOLD_SEC)).toBe(true);
      expect(isClosing(ph, 0)).toBe(true);
      expect(isClosing(ph, CLOSING_THRESHOLD_SEC + 1)).toBe(false);
    }
  });
  it("is never true in play, settled or void", () => {
    for (const ph of ["play", "settled", "void"] as const) {
      expect(isClosing(ph, 0)).toBe(false);
      expect(isClosing(ph, 3)).toBe(false);
    }
  });
});

describe("deriveRound", () => {
  const reads = [params, false, false] as const;
  it("flags closing in the last seconds of a window", () => {
    const v = deriveRound(reads, params.commitEnd - BigInt(CLOSING_THRESHOLD_SEC));
    expect(v).toMatchObject({ status: "ready", phase: "commit", countdownSec: CLOSING_THRESHOLD_SEC, closing: true });
    const w = deriveRound(reads, params.commitEnd - BigInt(CLOSING_THRESHOLD_SEC) - 1n);
    expect(w.closing).toBe(false);
  });
  it("is loading without data or without a block time", () => {
    expect(deriveRound(undefined, 5n).status).toBe("loading");
    expect(deriveRound(reads, undefined).status).toBe("loading");
  });
  it("reports error for malformed chain data", () => {
    expect(deriveRound([null, false, false], 5n).status).toBe("error");
    expect(deriveRound([params, "yes", false], 5n).status).toBe("error");
  });
  it("uses the contract flags for settled and void", () => {
    expect(deriveRound([params, true, false], 5n).phase).toBe("settled");
    expect(deriveRound([params, false, true], 5n).phase).toBe("void");
  });
});

describe("market hint", () => {
  it("does not promise that a bet can be placed (quorum may be missing)", () => {
    const hint = actionFor("market").hint;
    expect(hint).toMatch(/quorum/i);
    expect(hint).not.toMatch(/place a/i);
  });
});
