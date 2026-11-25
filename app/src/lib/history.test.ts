import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getAddress, stringToHex } from "viem";
import { score, type Path } from "../../../shared/score";
import { DashboardView } from "@/components/DashboardView";
import { RevealPlayer } from "@/components/RevealPlayer";
import { ReplayPanel } from "@/components/ReplayPanel";
import {
  HistoryError,
  ROUND_CALL_COUNT,
  isRangeLimitError,
  blockAtOrAfter,
  buildLeaderboard,
  chunkRanges,
  gapOf,
  loadHistory,
  outcomeOf,
  parseHouseAgents,
  parseRevealedLog,
  replayFrames,
  replayProps,
  simulatedRounds,
  summarizeRound,
  tally,
  trendPoints,
  winRate,
  type HistorySource,
  type RawLog,
  type RoundSummary,
} from "./history";
import { deriveReveal, parseRevealReads, revealFrame, STEP_COUNT } from "./reveal";

const T = 100;
const noSleep = async () => {};
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
const FLAT: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];
const HASH = `0x${"ab".repeat(32)}`;
const PARAMS = {
  ticker: stringToHex("AAPL", { size: 32 }),
  p0: 100000n,
  T,
  commitEnd: 1000n,
  revealEnd: 1100n,
  marketEnd: 1200n,
  candleSec: 60,
  settleDeadline: 2000n,
  entryStake: 10n,
};
const ok = (result: unknown) => ({ status: "success", result });
const fail = { status: "failure", error: new Error("revert") };

/** The 10 multicall results of one settled round, in ROUND_CALLS order. */
function settledResults(real: Path = REAL, human: Path = HUMAN, agent: Path = AGENT, humanReveals = 3n, agentReveals = 3n): unknown[] {
  return [
    ok(PARAMS),
    ok(true),
    ok(false),
    ok([real, HASH]),
    ok([human, true]),
    ok([agent, true]),
    ok([score(human, real, T), score(agent, real, T), true, true]),
    ok(score(FLAT, real, T)),
    ok(humanReveals),
    ok(agentReveals),
  ];
}
const voidResults = (): unknown[] => [ok(PARAMS), ok(false), ok(true), fail, fail, fail, fail, fail, fail, fail];
const openResults = (): unknown[] => [ok(PARAMS), ok(false), ok(false), fail, fail, fail, fail, fail, fail, fail];

function round(over: Partial<RoundSummary> & { id: bigint }): RoundSummary {
  return {
    ticker: "AAPL",
    T,
    commitEnd: 1000n,
    revealEnd: 1100n,
    state: "settled",
    humanScore: 50,
    agentScore: 50,
    baseline: 20,
    reads: null,
    entries: [],
    reveals: { human: 3, agent: 3 },
    simulated: false,
    ...over,
  };
}

describe("winRate", () => {
  it("winRate ignores void and tie rounds", () => {
    const rounds = [
      round({ id: 1n, humanScore: 80, agentScore: 60 }), // human win
      round({ id: 2n, humanScore: 70, agentScore: 50 }), // human win
      round({ id: 3n, humanScore: 90, agentScore: 10 }), // human win
      round({ id: 4n, humanScore: 40, agentScore: 41 }), // agent win
      round({ id: 5n, humanScore: 55, agentScore: 55 }), // tie
      round({ id: 6n, state: "void", humanScore: null, agentScore: null, baseline: null }),
      round({ id: 7n, state: "open", humanScore: null, agentScore: null, baseline: null }),
      round({ id: 8n, humanScore: null, agentScore: 70 }), // one side absent: no result
      round({ id: 9n, state: "unreadable", humanScore: null, agentScore: null }),
    ];
    expect(tally(rounds)).toEqual({ human: 3, agent: 1, tie: 1, void: 1, open: 1, belowQuorum: 0, noResult: 2 });
    // 3 of 4 decided rounds, and 1 of 4. The tie and the void do not count on either side.
    expect(winRate(rounds)).toEqual({ human: 75, agent: 25 });
  });

  it("a round with fewer than 3 reveals on a side is shown but not counted", () => {
    const below = round({ id: 1n, humanScore: 90, agentScore: 10, reveals: { human: 2, agent: 5 } });
    const belowAgent = round({ id: 2n, humanScore: 90, agentScore: 10, reveals: { human: 5, agent: 2 } });
    const atQuorum = round({ id: 3n, humanScore: 90, agentScore: 10, reveals: { human: 3, agent: 3 } });
    expect(outcomeOf(below)).toBe("none");
    expect(gapOf(below)).toBeNull();
    expect(tally([below, belowAgent])).toMatchObject({ human: 0, agent: 0, belowQuorum: 2, noResult: 0 });
    expect(winRate([below, belowAgent])).toEqual({ human: 0, agent: 0 });
    // Exactly 3 per side counts.
    expect(outcomeOf(atQuorum)).toBe("human");
    expect(winRate([below, belowAgent, atQuorum])).toEqual({ human: 100, agent: 0 });
  });

  it("is 0 / 0 when no round was decided, and never counts a tie as a win", () => {
    expect(winRate([])).toEqual({ human: 0, agent: 0 });
    expect(winRate([round({ id: 1n, humanScore: 60, agentScore: 60 })])).toEqual({ human: 0, agent: 0 });
  });

  it("outcome and gap come from the integer scores only", () => {
    expect(outcomeOf(round({ id: 1n, humanScore: 61, agentScore: 60 }))).toBe("human");
    expect(outcomeOf(round({ id: 1n, humanScore: 60, agentScore: 61 }))).toBe("agent");
    expect(outcomeOf(round({ id: 1n, humanScore: 60, agentScore: 60 }))).toBe("tie");
    expect(outcomeOf(round({ id: 1n, state: "void", humanScore: 90, agentScore: 10 }))).toBe("none");
    expect(gapOf(round({ id: 1n, humanScore: 61, agentScore: 70 }))).toBe(-9);
    expect(gapOf(round({ id: 1n, humanScore: null, agentScore: 70 }))).toBeNull();
    expect(gapOf(round({ id: 1n, state: "void", humanScore: 5, agentScore: 6 }))).toBeNull();
  });
});

describe("simulated rows", () => {
  it("simulated rows are labeled", () => {
    const sim = simulatedRounds();
    expect(sim.length).toBeGreaterThan(0);
    expect(sim.every((r) => r.simulated === true)).toBe(true);

    const html = renderToStaticMarkup(createElement(DashboardView, { rounds: sim, houseAgents: new Set<string>() }));
    // One visible label per round row, plus the banner, and the sample never claims to be chain data.
    const tags = html.match(/data-simulated-tag/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(sim.length);
    expect(html).toMatch(/simulated/i);
    expect(html).toMatch(/not read from the chain|not chain data/i);
    // Simulated scores are still real integer scores from the shared score(), never invented numbers.
    const settled = sim.filter((r) => r.state === "settled");
    expect(settled.length).toBeGreaterThan(0);
    for (const r of settled) {
      expect(r.reads).not.toBeNull();
      expect(r.humanScore).toBe(score(r.reads?.human as Path, r.reads?.real as Path, r.T));
      expect(r.agentScore).toBe(score(r.reads?.agent as Path, r.reads?.real as Path, r.T));
    }
    // The sample covers a void and a tie, so the win rate has something to ignore.
    expect(sim.some((r) => r.state === "void")).toBe(true);
    expect(sim.some((r) => outcomeOf(r) === "tie")).toBe(true);
  });

  it("rows read from the chain are never simulated and carry no simulated label", async () => {
    const rounds = await loadHistory(0n, mockSource({ results: { 1: settledResults() } }));
    expect(rounds.every((r) => r.simulated === false)).toBe(true);
    const html = renderToStaticMarkup(createElement(DashboardView, { rounds, houseAgents: new Set<string>() }));
    expect(html).not.toMatch(/data-simulated-tag/);
  });

  it("a simulated replay is labeled and does not claim to match the chain", () => {
    const sim = simulatedRounds().find((r) => r.state === "settled");
    expect(sim).toBeDefined();
    const html = renderToStaticMarkup(
      createElement(ReplayPanel, { rounds: [sim as RoundSummary], initialStep: STEP_COUNT, autoPlay: false }),
    );
    expect(html).toMatch(/data-simulated-tag/);
    expect(html).not.toMatch(/matches the on-chain/i);
    expect(html).not.toMatch(/posted on-chain by the project keeper/i);
  });
});

describe("replay", () => {
  const live = parseRevealReads(settledResults().slice(3, 8));

  it("replay renders the same frames as live reveal for a settled round", () => {
    expect(live).not.toBeNull();
    const summary = summarizeRound({ id: 7n, results: settledResults(), reveals: [] });
    expect(summary.state).toBe("settled");

    // Live reveal path: what the reveal page feeds the player once the round is settled.
    const view = deriveReveal({ phase: "settled", reads: live });
    expect(view.state).toBe("ready");
    const liveReads = view.reads;
    expect(liveReads).toBeDefined();
    if (!liveReads) return;
    const liveFrames = [0, 1, 2, 3].map((s) =>
      revealFrame({ real: liveReads.real, human: liveReads.human, agent: liveReads.agent, T }, s),
    );
    expect(replayFrames(summary)).toEqual(liveFrames);
    // Same generator end to end: the last frame is the contract score.
    expect(replayFrames(summary)[3]).toMatchObject({
      humanScore: score(HUMAN, REAL, T),
      agentScore: score(AGENT, REAL, T),
    });

    // And the same markup at every step, through the dashboard's ReplayPanel and through the player
    // exactly as the reveal page mounts it.
    for (let step = 0; step <= STEP_COUNT; step++) {
      const replayHtml = renderToStaticMarkup(
        createElement(ReplayPanel, { rounds: [summary], initialStep: step, autoPlay: false }),
      );
      const liveHtml = renderToStaticMarkup(
        createElement(RevealPlayer, {
          real: liveReads.real,
          human: liveReads.human,
          agent: liveReads.agent,
          T,
          ...(liveReads.scores ? { onchain: liveReads.scores } : {}),
          ...(liveReads.baseline !== undefined ? { baseline: liveReads.baseline } : {}),
          sourceHash: liveReads.sourceHash,
          initialStep: step,
          autoPlay: false,
        }),
      );
      expect(replayHtml).toContain(liveHtml);
    }
  });

  it("only a settled, readable round can be replayed", () => {
    const settled = summarizeRound({ id: 1n, results: settledResults(), reveals: [] });
    expect(replayProps(settled)).not.toBeNull();
    for (const results of [voidResults(), openResults()]) {
      expect(replayProps(summarizeRound({ id: 2n, results, reveals: [] }))).toBeNull();
    }
    expect(replayFrames(summarizeRound({ id: 2n, results: voidResults(), reveals: [] }))).toEqual([]);
  });
});

describe("summarizeRound (untrusted reads)", () => {
  it("reads scores from the contract and labels the round state", () => {
    const s = summarizeRound({ id: 3n, results: settledResults(), reveals: [] });
    expect(s).toMatchObject({
      id: 3n,
      ticker: "AAPL",
      T,
      state: "settled",
      humanScore: score(HUMAN, REAL, T),
      agentScore: score(AGENT, REAL, T),
      baseline: score(FLAT, REAL, T),
      simulated: false,
    });
    expect(summarizeRound({ id: 4n, results: voidResults(), reveals: [] }).state).toBe("void");
    expect(summarizeRound({ id: 5n, results: openResults(), reveals: [] }).state).toBe("open");
  });

  it("reads the reveal counts from the contract and applies the quorum from them", () => {
    const ok3 = summarizeRound({ id: 1n, results: settledResults(REAL, HUMAN, AGENT, 3n, 4n), reveals: [] });
    expect(ok3.reveals).toEqual({ human: 3, agent: 4 });
    const low = summarizeRound({ id: 1n, results: settledResults(REAL, HUMAN, AGENT, 2n, 9n), reveals: [] });
    expect(low.reveals).toEqual({ human: 2, agent: 9 });
    expect(outcomeOf(low)).toBe("none");
    expect(gapOf(low)).toBeNull();
    expect(low.humanScore).toBe(score(HUMAN, REAL, T)); // the scores are still shown
  });

  it("a failed or malformed revealCount makes the settled round unreadable, never a counted win", () => {
    for (const bad of [fail, ok(-1n), ok(3), ok("3")]) {
      const r = settledResults();
      r[8] = bad;
      const s = summarizeRound({ id: 1n, results: r, reveals: [] });
      expect(s.state).toBe("unreadable");
      expect(outcomeOf(s)).toBe("none");
    }
  });

  it("a void flag wins over a settled flag", () => {
    const r = settledResults();
    r[2] = ok(true);
    const s = summarizeRound({ id: 3n, results: r, reveals: [] });
    expect(s.state).toBe("void");
    expect(s.humanScore).toBeNull();
  });

  it("a side the contract flags absent has no score", () => {
    const r = settledResults();
    r[6] = ok([55, 66, false, true]);
    const s = summarizeRound({ id: 3n, results: r, reveals: [] });
    expect(s.humanScore).toBeNull();
    expect(s.agentScore).toBe(66);
    expect(outcomeOf(s)).toBe("none");
  });

  it("marks malformed or missing settled data as unreadable instead of guessing", () => {
    const badScore = settledResults();
    badScore[6] = ok([101, 5, true, true]);
    const badReal = settledResults();
    badReal[3] = ok([[{ close: 1, high: 0, low: 0 }, REAL[1], REAL[2]], HASH]); // high < close: invalid
    const noBaseline = settledResults();
    noBaseline[7] = fail;
    for (const results of [badScore, badReal, noBaseline]) {
      const s = summarizeRound({ id: 3n, results, reveals: [] });
      expect(s.state).toBe("unreadable");
      expect(s.humanScore).toBeNull();
      expect(s.agentScore).toBeNull();
      expect(s.reads).toBeNull();
    }
  });

  it("throws on unreadable round params or a wrong result count", () => {
    expect(() => summarizeRound({ id: 1n, results: [fail, ...openResults().slice(1)], reveals: [] })).toThrow(HistoryError);
    expect(() => summarizeRound({ id: 1n, results: [ok({ ...PARAMS, T: 0 }), ...openResults().slice(1)], reveals: [] })).toThrow(HistoryError);
    expect(() => summarizeRound({ id: 1n, results: [], reveals: [] })).toThrow(HistoryError);
    expect(ROUND_CALL_COUNT).toBe(10);
  });

  it("scores each revealed entry with the shared score() against the real candles", () => {
    const s = summarizeRound({
      id: 3n,
      
      results: settledResults(),
      reveals: [
        { id: 3n, who: "0x0000000000000000000000000000000000000001", kind: 1, path: HUMAN },
        { id: 3n, who: "0x0000000000000000000000000000000000000002", kind: 2, path: AGENT },
      ],
    });
    expect(s.entries).toEqual([
      { who: "0x0000000000000000000000000000000000000001", kind: 1, score: score(HUMAN, REAL, T) },
      { who: "0x0000000000000000000000000000000000000002", kind: 2, score: score(AGENT, REAL, T) },
    ]);
  });

  it("scores no entries for a round that did not settle", () => {
    const s = summarizeRound({
      id: 3n,
      
      results: voidResults(),
      reveals: [{ id: 3n, who: "0x0000000000000000000000000000000000000001", kind: 1, path: HUMAN }],
    });
    expect(s.entries).toEqual([]);
  });
});

describe("log parsing (untrusted)", () => {
  it("parses a Revealed log and rejects malformed ones", () => {
    const who = "0x0000000000000000000000000000000000000001";
    expect(parseRevealedLog({ eventName: "Revealed", args: { id: 1n, who, kind: 2, path: AGENT }, blockNumber: 1n })).toEqual({
      id: 1n,
      who,
      kind: 2,
      path: AGENT,
    });
    expect(parseRevealedLog({ eventName: "Committed", args: { id: 1n, who, kind: 2, path: AGENT }, blockNumber: 1n })).toBeNull();
    for (const args of [
      { id: 1n, who: "nope", kind: 1, path: AGENT },
      { id: 1n, who, kind: 0, path: AGENT },
      { id: 1n, who, kind: 3, path: AGENT },
      { id: 1n, who, kind: 1, path: [{ close: 1, high: 0, low: 0 }, AGENT[1], AGENT[2]] },
      { id: 0n, who, kind: 1, path: AGENT },
      null,
    ]) {
      expect(parseRevealedLog({ eventName: "Revealed", args, blockNumber: 1n })).toBeNull();
    }
  });
});

describe("log range bounds", () => {
  it("chunks an inclusive range into bounded, contiguous pieces", () => {
    expect(chunkRanges(10n, 24n, 5n)).toEqual([
      [10n, 14n],
      [15n, 19n],
      [20n, 24n],
    ]);
    expect(chunkRanges(10n, 22n, 5n)).toEqual([
      [10n, 14n],
      [15n, 19n],
      [20n, 22n],
    ]);
    expect(chunkRanges(5n, 4n, 5n)).toEqual([]);
    expect(() => chunkRanges(0n, 10n, 0n)).toThrow();
  });
});

describe("blockAtOrAfter", () => {
  const steady = (n: bigint) => 5_000n + 2n * n;
  const ref = (n: bigint, f: (n: bigint) => bigint) => ({ number: n, time: f(n) });

  it("finds the first block at or after a timestamp, in few reads when block times are steady", async () => {
    let reads = 0;
    const timeOf = async (n: bigint) => {
      reads++;
      return steady(n);
    };
    const lo = ref(0n, steady);
    const hi = ref(10_000n, steady);
    expect(await blockAtOrAfter(steady(4_000n), lo, hi, timeOf)).toBe(4_000n);
    expect(await blockAtOrAfter(steady(4_000n) - 1n, lo, hi, timeOf)).toBe(4_000n); // between blocks: the next one
    expect(reads).toBeLessThan(8);
    expect(await blockAtOrAfter(0n, lo, hi, timeOf)).toBe(0n); // not after lo: lo
    expect(await blockAtOrAfter(hi.time, lo, hi, timeOf)).toBe(10_000n);
    expect(await blockAtOrAfter(hi.time + 1n, lo, hi, timeOf)).toBe(10_001n); // not mined yet
  });

  it("handles several blocks per second (a shared timestamp) and finds the first of them", async () => {
    const fast = (n: bigint) => 1_000n + n / 5n; // 5 blocks per second (a made-up steady rate)
    const timeOf = async (n: bigint) => fast(n);
    const lo = ref(0n, fast);
    const hi = ref(100_000n, fast);
    for (const target of [1_234n, 50_000n, 99_999n]) {
      const first = target - (target % 5n);
      expect(await blockAtOrAfter(fast(target), lo, hi, timeOf)).toBe(first);
    }
  });

  it("is exact when block times are irregular (a downtime gap)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 120 }),
        fc.nat(5_000),
        async (gaps, tsRaw) => {
          const times: bigint[] = [];
          let t = 1_000n;
          for (const g of gaps) {
            t += BigInt(g);
            times.push(t);
          }
          const last = BigInt(times.length - 1);
          const ts = BigInt(tsRaw);
          const got = await blockAtOrAfter(
            ts,
            { number: 0n, time: times[0] as bigint },
            { number: last, time: times[times.length - 1] as bigint },
            async (n) => times[Number(n)] as bigint,
          );
          const expected = times.findIndex((x) => x >= ts);
          expect(got).toBe(expected === -1 ? last + 1n : BigInt(expected));
        },
      ),
      { numRuns: 300 },
    );
  });
});

type MockOpts = {
  /** Round id -> the 10 multicall results. Rounds are 1..count. */
  results: Record<number, unknown[]>;
  count?: number;
  logs?: RawLog[];
  /** Throw for any getRevealLogs call spanning more than this many blocks. */
  maxSpan?: bigint;
  failLogsAlways?: boolean;
  /** Fail the first N getRevealLogs calls. */
  failFirst?: number;
  failMessage?: string;
  headNumber?: bigint;
};

/** Block n has timestamp 2n, so PARAMS (commit ends 1000 s, reveal ends 1100 s) means blocks 500..550. */
function mockSource(o: MockOpts): HistorySource & { calls: [bigint, bigint][]; timeReads: number } {
  const calls: [bigint, bigint][] = [];
  const headNumber = o.headNumber ?? 1_000n;
  const src = {
    calls,
    timeReads: 0,
    head: async () => ({ number: headNumber, time: headNumber * 2n }),
    blockTime: async (n: bigint) => {
      src.timeReads++;
      return n * 2n;
    },
    roundCount: async (): Promise<unknown> => BigInt(o.count ?? Object.keys(o.results).length),
    getRevealLogs: async (id: bigint, from: bigint, to: bigint) => {
      calls.push([from, to]);
      if (o.failLogsAlways || calls.length <= (o.failFirst ?? 0)) throw new Error(o.failMessage ?? "rate limited");
      if (o.maxSpan !== undefined && to - from + 1n > o.maxSpan) throw new Error("eth_getLogs is limited to a 200 range");
      return (o.logs ?? []).filter(
        (l) => l.blockNumber !== null && l.blockNumber >= from && l.blockNumber <= to && (l.args as { id?: unknown }).id === id,
      );
    },
    readRounds: async (ids: readonly bigint[]) => ids.map((id) => o.results[Number(id)] ?? openResults()),
  };
  return src;
}

describe("loadHistory", () => {
  const who = "0x0000000000000000000000000000000000000001";
  const rev = (id: bigint, block: bigint, w = who) => ({
    eventName: "Revealed",
    args: { id, who: w, kind: 1, path: HUMAN },
    blockNumber: block,
  });

  it("returns rounds in id order with their state and scored entries", async () => {
    const src = mockSource({
      results: { 1: settledResults(), 2: voidResults(), 3: openResults() },
      logs: [
        rev(1n, 520n),
        // The same reveal returned twice (overlapping chunks): counted once.
        rev(1n, 520n),
        // A reveal of another round, and one outside the reveal window: ignored.
        rev(2n, 520n, "0x0000000000000000000000000000000000000002"),
        rev(1n, 900n, "0x0000000000000000000000000000000000000003"),
        // Garbage is dropped, not rendered.
        { eventName: "Revealed", args: { id: 1n, who: "bad", kind: 1, path: HUMAN }, blockNumber: 521n },
      ],
    });
    const rounds = await loadHistory(0n, src);
    expect(rounds.map((r) => [r.id, r.state])).toEqual([
      [1n, "settled"],
      [2n, "void"],
      [3n, "open"],
    ]);
    expect(rounds[0]?.entries).toEqual([{ who, kind: 1, score: score(HUMAN, REAL, T) }]);
    expect(rounds[1]?.entries).toEqual([]);
    expect(rounds.every((r) => r.simulated === false)).toBe(true);
  });

  it("scans only the reveal window of a settled round, in bounded contiguous chunks", async () => {
    const src = mockSource({ results: { 1: settledResults(), 2: voidResults(), 3: openResults() } });
    await loadHistory(0n, src, { chunkBlocks: 20n });
    // Only the settled round is scanned; the window is blocks 500..550 (one block of margin before).
    const spans = [...src.calls].sort((a, b) => Number(a[0] - b[0]));
    expect(spans[0]?.[0]).toBe(499n);
    expect(spans[spans.length - 1]?.[1]).toBe(550n);
    for (const [from, to] of spans) expect(to - from + 1n).toBeLessThanOrEqual(20n);
    for (let i = 1; i < spans.length; i++) {
      expect((spans[i] as [bigint, bigint])[0]).toBe((spans[i - 1] as [bigint, bigint])[1] + 1n);
    }
  });

  it("splits a range the node rejects as too large and still returns the entries", async () => {
    const src = mockSource({ results: { 1: settledResults() }, logs: [rev(1n, 549n)], maxSpan: 20n });
    const rounds = await loadHistory(0n, src, { chunkBlocks: 1000n });
    expect(rounds[0]?.entries).toHaveLength(1);
    expect(src.calls.some(([f, t]) => t - f + 1n > 20n)).toBe(true); // the first attempt was rejected
  });

  it("rejects with a HistoryError when the node keeps failing, never a partial or empty list", async () => {
    const src = mockSource({ results: { 1: settledResults() }, failLogsAlways: true });
    await expect(loadHistory(0n, src, { chunkBlocks: 50n, sleep: noSleep })).rejects.toBeInstanceOf(HistoryError);
  });

  it("a rate limit (429) is retried with backoff and then fails; it is never split into tiny ranges", async () => {
    const delays: number[] = [];
    const src = mockSource({
      results: { 1: settledResults() },
      failLogsAlways: true,
      failMessage: "HTTP request failed. Status: 429 Too Many Requests",
    });
    await expect(
      loadHistory(0n, src, { chunkBlocks: 200n, sleep: async (ms) => void delays.push(ms), retryDelaysMs: [10, 20, 30] }),
    ).rejects.toBeInstanceOf(HistoryError);
    // One chunk: the first try plus 3 retries, all on the same range, with growing waits.
    expect(src.calls).toHaveLength(4);
    expect(new Set(src.calls.map((c) => `${c[0]}-${c[1]}`)).size).toBe(1);
    expect(delays).toEqual([10, 20, 30]);
  });

  it("recovers when a transient error clears, without splitting", async () => {
    const src = mockSource({ results: { 1: settledResults() }, logs: [rev(1n, 520n)], failFirst: 2, failMessage: "timeout" });
    const rounds = await loadHistory(0n, src, { chunkBlocks: 200n, sleep: noSleep });
    expect(rounds[0]?.entries).toHaveLength(1);
    expect(src.calls).toHaveLength(3);
  });

  it("classifies range-limit errors apart from rate limits", () => {
    expect(isRangeLimitError(new Error("eth_getLogs is limited to a 200 range"))).toBe(true);
    expect(isRangeLimitError({ code: -32614 })).toBe(true);
    expect(isRangeLimitError({ status: 413 })).toBe(true);
    expect(isRangeLimitError(new Error("query returned more than 10000 results"))).toBe(true);
    expect(isRangeLimitError(new Error("HTTP request failed. Status: 429 Too Many Requests"))).toBe(false);
    expect(isRangeLimitError(new Error("request timed out"))).toBe(false);
    expect(isRangeLimitError(new Error("rate limit exceeded: block range"))).toBe(false);
  });

  it("refuses a reveal window that would need too many requests", async () => {
    const wide = settledResults();
    wide[0] = ok({ ...PARAMS, revealEnd: 400_000n, marketEnd: 500_000n, settleDeadline: 600_000n });
    const src = mockSource({ results: { 1: wide }, headNumber: 1_000_000n });
    await expect(loadHistory(0n, src, { chunkBlocks: 200n })).rejects.toBeInstanceOf(HistoryError);
    expect(src.calls).toHaveLength(0);
  });

  it("reads no logs for void or open rounds, and returns an honest empty list for no rounds", async () => {
    const src = mockSource({ results: { 1: voidResults(), 2: openResults() } });
    await loadHistory(0n, src);
    expect(src.calls).toHaveLength(0);
    expect(await loadHistory(0n, mockSource({ results: {}, count: 0 }))).toEqual([]);
    expect(await loadHistory(5_000n, mockSource({ results: { 1: settledResults() }, headNumber: 1_000n }))).toEqual([]);
  });

  it("keeps only rounds whose commit ended at or after fromBlock, and the most recent maxRounds", async () => {
    const early = settledResults();
    early[0] = ok({ ...PARAMS, commitEnd: 100n, revealEnd: 200n });
    const src = mockSource({ results: { 1: early, 2: settledResults(), 3: settledResults() } });
    // Block 400 is at 800 s: round 1 (commit ended at 100 s) is older, 2 and 3 (1000 s) are in.
    expect((await loadHistory(400n, src)).map((r) => r.id)).toEqual([2n, 3n]);
    expect((await loadHistory(0n, src, { maxRounds: 2 })).map((r) => r.id)).toEqual([2n, 3n]);
  });

  it("rejects when the multicall fails, the round count is malformed or the shape is wrong", async () => {
    const base = mockSource({ results: { 1: settledResults() } });
    await expect(loadHistory(0n, { ...base, readRounds: async () => [[ok(PARAMS)]] })).rejects.toBeInstanceOf(HistoryError);
    await expect(
      loadHistory(0n, {
        ...base,
        readRounds: async () => {
          throw new Error("rpc down");
        },
      }),
    ).rejects.toBeInstanceOf(HistoryError);
    await expect(loadHistory(0n, { ...base, readRounds: async () => [] })).rejects.toBeInstanceOf(HistoryError);
    await expect(loadHistory(0n, { ...base, roundCount: async () => "3" })).rejects.toBeInstanceOf(HistoryError);
    await expect(
      loadHistory(0n, {
        ...base,
        head: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toBeInstanceOf(HistoryError);
  });
});

describe("leaderboard", () => {
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const H = "0x00000000000000000000000000000000000000c3";

  it("ranks by integer average and labels house agents; void rounds add nothing", () => {
    const rounds: RoundSummary[] = [
      round({
        id: 1n,
        entries: [
          { who: A, kind: 1, score: 80 },
          { who: B, kind: 1, score: 60 },
          { who: H, kind: 2, score: 90 },
        ],
      }),
      round({
        id: 2n,
        entries: [
          { who: A, kind: 1, score: 70 },
          { who: B, kind: 1, score: 90 },
        ],
      }),
      round({ id: 3n, state: "void", entries: [{ who: A, kind: 1, score: 5 }] }),
    ];
    const board = buildLeaderboard(rounds, new Set([H.toLowerCase()]));
    expect(board.map((r) => r.who)).toEqual([H, A, B]); // 90, 75, 75 (A and B tie: more rounds equal, address order)
    expect(board[0]).toMatchObject({ kind: 2, house: true, rounds: 1, best: 90, avg10: 900 });
    expect(board[1]).toMatchObject({ kind: 1, house: false, rounds: 2, best: 80, avg10: 750 });
    // An agent not on the house list is an agent, never a human, and not labeled house.
    const other = buildLeaderboard(rounds, new Set<string>());
    expect(other[0]).toMatchObject({ who: H, kind: 2, house: false });
  });

  it("an address that changed kind gets one row per kind, never one blended row", () => {
    const rounds: RoundSummary[] = [
      round({ id: 1n, entries: [{ who: A, kind: 1, score: 90 }] }),
      round({ id: 2n, entries: [{ who: A, kind: 2, score: 10 }] }),
      round({ id: 3n, entries: [{ who: A, kind: 2, score: 20 }] }),
    ];
    const board = buildLeaderboard(rounds, new Set<string>());
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ who: A, kind: 1, rounds: 1, avg10: 900 });
    expect(board[1]).toMatchObject({ who: A, kind: 2, rounds: 2, avg10: 150, best: 20 });
  });

  it("is empty with no entries", () => {
    expect(buildLeaderboard([], new Set<string>())).toEqual([]);
  });

  it("house address list: checksummed, deduped, and fails loudly on a bad entry", () => {
    const lower = "0x576584847bd041427a6d04691fca5a83dfe1ade4";
    const sum = getAddress(lower);
    expect(parseHouseAgents(undefined)).toEqual({ addresses: new Set(), error: null });
    const deduped = parseHouseAgents([lower, sum]);
    expect(deduped.error).toBeNull();
    expect(deduped.addresses).toEqual(new Set([lower]));
    expect(parseHouseAgents(["nope"]).error).toMatch(/house agent/i);
    expect(parseHouseAgents("not an array").error).toMatch(/house agent/i);
    // A mixed-case address with a wrong checksum is rejected (a typo must not silently drop the label).
    const body = sum.slice(2);
    const i = body.search(/[a-f]/i);
    const flipped = body[i] === body[i]?.toUpperCase() ? body[i]?.toLowerCase() : body[i]?.toUpperCase();
    const typo = `0x${body.slice(0, i)}${flipped}${body.slice(i + 1)}`;
    expect(parseHouseAgents([typo]).error).toMatch(/house agent/i);
  });
});

describe("trend geometry", () => {
  it("maps gaps -100..100 into the plot, human ahead above the zero line", () => {
    const pts = trendPoints([100, 0, -100], { width: 400, height: 200, padLeft: 40, padRight: 10, padTop: 10, padBottom: 30 });
    expect(pts.zeroY).toBe(90); // top 10, plot height 160, centre
    expect(pts.points.map((p) => p.y)).toEqual([10, 90, 170]);
    expect(pts.points[0]?.x).toBe(40);
    expect(pts.points[2]?.x).toBe(390);
  });

  it("a single point sits centred and an empty series has no points", () => {
    const one = trendPoints([5], { width: 400, height: 200, padLeft: 40, padRight: 10, padTop: 10, padBottom: 30 });
    expect(one.points).toHaveLength(1);
    expect(one.points[0]?.x).toBe(215);
    expect(trendPoints([], { width: 400, height: 200, padLeft: 40, padRight: 10, padTop: 10, padBottom: 30 }).points).toEqual([]);
  });
});
