import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { score } from "../../../shared/score";
import { NO_ENDORSEMENT, US_NOTICE } from "./disclaimer";
import {
  baselineLine,
  cardParamsFor,
  CARD_FOOTER,
  cardUrl,
  cardVerifyLine,
  deriveMyResult,
  nearMissLine,
  parseCardParams,
  parseEntryRead,
} from "./near";

const T = 100;
const REAL: Path = [
  { close: 40, high: 70, low: -5 },
  { close: 10, high: 50, low: 0 },
  { close: 60, high: 85, low: 5 },
];
const MINE: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];

describe("nearMissLine", () => {
  it('nearMissLine(87, 90) === "87, 3 short of beating the Agent"', () => {
    expect(nearMissLine(87, 90)).toBe("87, 3 short of beating the Agent");
  });

  it("nearMissLine(95, 90) returns a win line", () => {
    expect(nearMissLine(95, 90)).toBe("95, beat the Agent by 5");
  });

  it("an equal score is level, not a win and not a miss", () => {
    expect(nearMissLine(90, 90)).toBe("90, level with the Agent");
  });

  it("handles the ends of the range", () => {
    expect(nearMissLine(0, 100)).toBe("0, 100 short of beating the Agent");
    expect(nearMissLine(100, 0)).toBe("100, beat the Agent by 100");
  });

  it("rejects anything that is not an integer score 0..100", () => {
    for (const bad of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      expect(() => nearMissLine(bad, 50)).toThrow(RangeError);
      expect(() => nearMissLine(50, bad)).toThrow(RangeError);
    }
  });
});

describe("baselineLine", () => {
  it("says above, level and below the flat path", () => {
    expect(baselineLine(87, 60)).toBe("27 above the flat-path baseline (60)");
    expect(baselineLine(60, 60)).toBe("Level with the flat-path baseline (60): no reward");
    expect(baselineLine(40, 60)).toBe("20 below the flat-path baseline (60): no reward");
  });
});

describe("parseEntryRead", () => {
  const ok = [1, true, "0x" + "00".repeat(32), MINE.map((c) => ({ ...c }))];

  it("accepts a well-formed entryOf result", () => {
    expect(parseEntryRead(ok)).toEqual({ kind: 1, revealed: true, path: MINE });
  });

  it("rejects malformed or invalid data (untrusted)", () => {
    expect(parseEntryRead(null)).toBeNull();
    expect(parseEntryRead([1, true])).toBeNull();
    expect(parseEntryRead([9, true, "0x", MINE])).toBeNull();
    expect(parseEntryRead([1, "yes", "0x", MINE])).toBeNull();
    // high below the close is not a valid path
    expect(parseEntryRead([1, true, "0x", [{ close: 50, high: 10, low: 0 }, MINE[1], MINE[2]]])).toBeNull();
  });
});

describe("deriveMyResult", () => {
  const base = { connected: true, real: REAL, T };

  it("computes my score with the shared score() for a revealed human entry", () => {
    const r = deriveMyResult({ ...base, entry: { kind: 1, revealed: true, path: MINE } });
    expect(r).toEqual({ state: "ready", score: score(MINE, REAL, T) });
  });

  it("matches a hand-computed score (T = 100, only candle 1 differs from the real path)", () => {
    // Candle 1: |dc| = 10 -> C = 10000 - 10*10000/100 = 9000; |dh| + |dl| = 10 + 5 = 15 -> R = 10000 - 15*10000/200 = 9250;
    // both closes are above the open -> D = 10000; s = 5*9000 + 2*9250 + 3*10000 = 93500.
    // Candles 2 and 3 equal the real ones (same directions: down, up) -> s = 100000 each.
    // score = floor((93500 + 100000 + 100000) * 100 / 300000) = floor(97.83) = 97.
    const mine: Path = [{ close: 50, high: 80, low: -10 }, REAL[1], REAL[2]];
    expect(deriveMyResult({ ...base, entry: { kind: 1, revealed: true, path: mine } })).toEqual({ state: "ready", score: 97 });
    // The same path with T = 1000 scores 99, so T really reaches the score.
    expect(deriveMyResult({ ...base, T: 1000, entry: { kind: 1, revealed: true, path: mine } })).toEqual({ state: "ready", score: 99 });
  });

  it("does not guess when something is missing", () => {
    expect(deriveMyResult({ ...base, connected: false, entry: undefined }).state).toBe("no-wallet");
    expect(deriveMyResult({ ...base, entry: undefined }).state).toBe("loading");
    expect(deriveMyResult({ ...base, entry: null }).state).toBe("error");
    expect(deriveMyResult({ ...base, entry: { kind: 0, revealed: false, path: MINE } }).state).toBe("no-entry");
    expect(deriveMyResult({ ...base, entry: { kind: 1, revealed: false, path: MINE } }).state).toBe("unrevealed");
    expect(deriveMyResult({ ...base, entry: { kind: 2, revealed: true, path: MINE } }).state).toBe("agent-entry");
  });
});

describe("card params and url", () => {
  const p = (q: string) => parseCardParams(new URLSearchParams(q));

  it("accepts the minimal and the full set", () => {
    expect(p("me=87&agent=90")).toEqual({ ok: true, value: { me: 87, agent: 90 } });
    expect(p("me=87&agent=90&base=60&round=12&t=AAPL")).toEqual({
      ok: true,
      value: { me: 87, agent: 90, base: 60, round: "12", ticker: "AAPL" },
    });
  });

  it("rejects missing, out of range, non-integer, repeated and odd-shaped values", () => {
    const bad = [
      "",
      "me=87",
      "agent=90",
      "me=101&agent=90",
      "me=-1&agent=90",
      "me=8.5&agent=90",
      "me=1e1&agent=90",
      "me=0x10&agent=90",
      "me=%2087&agent=90",
      "me=087&agent=90",
      "me=87&me=88&agent=90",
      "me=87&agent=90&base=101",
      "me=87&agent=90&round=1234567890123",
      "me=87&agent=90&round=-1",
      "me=87&agent=90&t=aapl",
      "me=87&agent=90&t=TOOLONGTICKER",
      "me=87&agent=90&t=%3Cb%3E",
      "me=87&agent=90&x=1",
      "me=87&agent=90&Me=1",
      "me=87&agent=90&cachebust=123",
    ];
    for (const q of bad) expect(p(q).ok, q).toBe(false);
  });

  it("cardUrl round-trips through parseCardParams", () => {
    const url = cardUrl({ me: 87, agent: 90, base: 60, round: "12", ticker: "AAPL" });
    expect(url.startsWith("/api/card?")).toBe(true);
    expect(parseCardParams(new URL(url, "http://x").searchParams)).toEqual({
      ok: true,
      value: { me: 87, agent: 90, base: 60, round: "12", ticker: "AAPL" },
    });
  });
});

describe("cardParamsFor", () => {
  it("drops optional fields that would not pass the strict parser and rejects bad scores", () => {
    expect(cardParamsFor({ me: 87, agent: 90, base: 60, round: "12", ticker: "AAPL" })).toEqual({
      me: 87, agent: 90, base: 60, round: "12", ticker: "AAPL",
    });
    expect(cardParamsFor({ me: 87, agent: 90, base: 101, round: "<b>", ticker: "aapl.x" })).toEqual({ me: 87, agent: 90 });
    expect(() => cardParamsFor({ me: 101, agent: 90 })).toThrow(RangeError);
  });
});

describe("card footer and verify line", () => {
  it("the footer is built from the shared disclaimer and keeps every required notice", () => {
    expect(CARD_FOOTER).toBe(`${US_NOTICE} ${NO_ENDORSEMENT}`);
    for (const needle of [
      "Testnet",
      "points only",
      "not an offer of securities",
      "Not investment advice",
      "US users",
      "no rights in any underlying company",
      "not endorsed by Base",
    ]) {
      expect(CARD_FOOTER, needle).toContain(needle);
    }
  });

  it("says the card is self-reported and names the round to verify", () => {
    expect(cardVerifyLine("12")).toBe("Self-reported from the link. Verify round #12 on Base Sepolia.");
    expect(cardVerifyLine()).toBe("Self-reported from the link. Verify the round on Base Sepolia.");
    expect(cardVerifyLine("<b>")).toBe("Self-reported from the link. Verify the round on Base Sepolia.");
  });
});
