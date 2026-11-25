// Pure logic for the Gap Dashboard (screen 6): reading the round history from chain logs and views,
// win rate, trend geometry, leaderboard and replay inputs. Everything read from the chain is untrusted
// and validated before use. No scoring is implemented here: consensus scores come from the contract and
// every locally computed score (a leaderboard entry, a replay frame, a simulated sample) calls `score`
// in shared/score.ts. All values are integers (scores 0..100, bp relative to P0); no float is used.

import { isAddress } from "viem";
import { score, type Path } from "../../../shared/score";
import { parsePath, successOf } from "./chainData";
import { KIND_AGENT, KIND_HUMAN } from "./market";
import { parseRevealReads, revealFrame, STEP_COUNT, type ConsensusScores, type RevealFrame, type RevealReads } from "./reveal";
import { parseRoundParams, parseStatus, tickerLabel } from "./round";

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

// ---- Types ----

/** `unreadable`: settled on-chain but the posted data did not validate, so no score is shown. */
export type RoundState = "settled" | "void" | "open" | "unreadable";

export type RoundEntry = {
  /** Wallet address of a chain entry, or a "sample-..." label of a simulated one. */
  who: string;
  kind: 1 | 2;
  /** The entry's own path scored against the real candles with the shared `score` (0..100). */
  score: number;
};

export type RoundSummary = {
  id: bigint;
  ticker: string;
  /** Round tolerance in bp. */
  T: number;
  /** Unix seconds: reveals are accepted in `[commitEnd, revealEnd)`. Null for a simulated round. */
  commitEnd: bigint | null;
  revealEnd: bigint | null;
  state: RoundState;
  /** Contract consensus scores; null when the round did not settle or that side had no consensus. */
  humanScore: number | null;
  agentScore: number | null;
  /** Score of the flat path, from the contract. */
  baseline: number | null;
  /** The validated settled reads, shared with the live reveal screen. Null unless settled and readable. */
  reads: RevealReads | null;
  entries: readonly RoundEntry[];
  /** Reveals per kind from `revealCount`; null when not settled or the read failed (then unreadable). */
  reveals: { human: number; agent: number } | null;
  /** True only for rows produced by `simulatedRounds`. Chain rows are always false. */
  simulated: boolean;
};

// ---- Round summary from untrusted reads ----

/** Number of contract reads per round, in the order of `roundCallSpecs`. */
export const ROUND_CALL_COUNT = 10;

/**
 * Reveals needed on each side for a market to open and for a round to count in the Human versus Agent
 * result (Global Constraints: quorum >= 3 reveals per side, otherwise the market is cancelled). It
 * equals `GapMarket.MIN_REVEALS`; the app has no other shared constant for it.
 */
export const QUORUM_MIN_REVEALS = 3;

/**
 * The reads of one round, in the order `summarizeRound` expects:
 * getRound, settled, isVoid, then the five reveal reads (realCandles, consensus human, consensus agent,
 * consensusScores, baselineScore) that `parseRevealReads` takes (the latter revert before settlement),
 * then revealCount for Human and for Agent.
 */
export function roundCallSpecs(id: bigint): { functionName: string; args: readonly unknown[] }[] {
  return [
    { functionName: "getRound", args: [id] },
    { functionName: "settled", args: [id] },
    { functionName: "isVoid", args: [id] },
    { functionName: "realCandles", args: [id] },
    { functionName: "consensus", args: [id, KIND_HUMAN] },
    { functionName: "consensus", args: [id, KIND_AGENT] },
    { functionName: "consensusScores", args: [id] },
    { functionName: "baselineScore", args: [id] },
    { functionName: "revealCount", args: [id, KIND_HUMAN] },
    { functionName: "revealCount", args: [id, KIND_AGENT] },
  ];
}

export type ParsedReveal = { id: bigint; who: string; kind: 1 | 2; path: Path };

/**
 * Builds one round row. Throws `HistoryError` only when the round itself cannot be read (params or
 * status flags malformed or failed): a round that opened must not silently vanish. Settled data that
 * does not validate yields state `unreadable`, never a guessed score. A void flag wins over a settled
 * flag (the contract's `isVoid` is authoritative).
 */
export function summarizeRound(input: {
  id: bigint;
  results: readonly unknown[];
  reveals: readonly ParsedReveal[];
}): RoundSummary {
  const { id, results } = input;
  if (results.length !== ROUND_CALL_COUNT) throw new HistoryError(`Unexpected read result for round #${id}.`);
  const p = successOf(results[0]);
  const params = p === null ? null : parseRoundParams(p.result);
  const settledS = successOf(results[1]);
  const voidS = successOf(results[2]);
  const flags = settledS === null || voidS === null ? null : parseStatus(settledS.result, voidS.result);
  if (params === null || flags === null) throw new HistoryError(`Could not read round #${id} from Base Sepolia.`);

  const base = {
    id,
    ticker: tickerLabel(params.ticker),
    T: params.T,
    commitEnd: params.commitEnd,
    revealEnd: params.revealEnd,
    humanScore: null,
    agentScore: null,
    baseline: null,
    reads: null,
    entries: [] as readonly RoundEntry[],
    reveals: null,
    simulated: false,
  };
  if (flags.isVoid) return { ...base, state: "void" };
  if (!flags.settled) return { ...base, state: "open" };

  const reads = parseRevealReads(results.slice(3, 8));
  const revealCounts = parseRevealCounts(results[8], results[9]);
  if (reads === null || reads.scores === undefined || reads.baseline === undefined || revealCounts === null) {
    return { ...base, state: "unreadable" };
  }
  return {
    ...base,
    state: "settled",
    humanScore: reads.scores.humanPresent ? reads.scores.human : null,
    agentScore: reads.scores.agentPresent ? reads.scores.agent : null,
    baseline: reads.baseline,
    reads,
    entries: scoreEntries(input.reveals.filter((r) => r.id === id), reads.real, params.T),
    reveals: revealCounts,
  };
}

/** `revealCount` results (uint256) as safe integers; null when either read failed or is malformed. */
function parseRevealCounts(human: unknown, agent: unknown): { human: number; agent: number } | null {
  const h = successOf(human);
  const a = successOf(agent);
  if (h === null || a === null) return null;
  const ok = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER);
  if (!ok(h.result) || !ok(a.result)) return null;
  return { human: Number(h.result), agent: Number(a.result) };
}

/** Whether both sides reached the reveal quorum. Unknown counts (not settled, unreadable) are not a quorum. */
export function hasQuorum(r: RoundSummary): boolean {
  return r.reveals !== null && r.reveals.human >= QUORUM_MIN_REVEALS && r.reveals.agent >= QUORUM_MIN_REVEALS;
}

/** Scores each revealed path against the real candles; one entry per address, bad paths skipped. */
function scoreEntries(reveals: readonly ParsedReveal[], real: Path, T: number): RoundEntry[] {
  const seen = new Set<string>();
  const out: RoundEntry[] = [];
  for (const r of reveals) {
    const key = r.who.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      out.push({ who: r.who, kind: r.kind, score: score(r.path, real, T) });
    } catch {
      // A path the shared score rejects is not shown.
    }
  }
  return out;
}

// ---- Untrusted logs ----

/** A decoded log as the chain source returns it. `args` is untrusted. */
export type RawLog = { eventName: string; args: unknown; blockNumber: bigint | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isRoundId = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n;

export function parseRevealedLog(log: RawLog): ParsedReveal | null {
  if (log.eventName !== "Revealed" || !isObj(log.args)) return null;
  const { id, who, kind, path } = log.args;
  if (!isRoundId(id)) return null;
  if (typeof who !== "string" || !isAddress(who, { strict: false })) return null;
  if (kind !== KIND_HUMAN && kind !== KIND_AGENT) return null;
  const p = parsePath(path);
  return p === null ? null : { id, who, kind: kind as 1 | 2, path: p };
}

// ---- Bounded log scan ----
//
// The public Base Sepolia RPC rejects eth_getLogs over more than 200 blocks, so a scan from the deploy
// block is not possible there. Reveals happen only in `[commitEnd, revealEnd)` of a round, so the scan
// is per settled round, over just that window (found from block timestamps), chunked and halved on a
// range error.

/** Blocks per getLogs call. A rejected range is split further; this matches the public RPC's limit. */
export const LOG_CHUNK_BLOCKS = 200n;
/** Most recent rounds loaded in one go. */
export const MAX_ROUNDS = 200;
/** Most getLogs chunks one round's reveal window may need (a larger window is refused). */
const MAX_WINDOW_CHUNKS = 50;
const CONCURRENCY = 3;
const MIN_SPLIT_BLOCKS = 16n;
const READ_BATCH = 20;

/** Inclusive `[from, to]` pieces of at most `size` blocks. */
export function chunkRanges(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  if (size <= 0n) throw new RangeError("size must be positive");
  const out: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += size) {
    const t = f + size - 1n;
    out.push([f, t < to ? t : to]);
  }
  return out;
}

/** What the history needs from a chain. The viem adapter is in `historySource.ts`. */
export interface HistorySource {
  /** The latest block's number and unix timestamp. */
  head(): Promise<{ number: bigint; time: bigint }>;
  /** Unix timestamp of block `n`. */
  blockTime(n: bigint): Promise<bigint>;
  /** `Arena.roundCount()`, untrusted. */
  roundCount(): Promise<unknown>;
  /** `Revealed` logs of round `id` in `[from, to]` (inclusive). */
  getRevealLogs(id: bigint, from: bigint, to: bigint): Promise<RawLog[]>;
  /** For each id, `ROUND_CALL_COUNT` allowFailure multicall results in `roundCallSpecs` order. */
  readRounds(ids: readonly bigint[]): Promise<unknown[][]>;
}

export type LoadOptions = {
  chunkBlocks?: bigint;
  maxRounds?: number;
  /** Delays between retries of a failing (not range-limited) log request. Default 0.5 s, 1.5 s, 3 s. */
  retryDelaysMs?: readonly number[];
  /** Replaceable for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/** A block known by number and unix timestamp. */
export type BlockRef = { number: bigint; time: bigint };

/**
 * The first block whose timestamp is at or after `ts` (block times never decrease), searched between
 * two known blocks. Returns `hi.number + 1` when even `hi` is earlier, and `lo.number` when `ts` is not
 * after `lo`. It interpolates between the bracket ends (no block rate is assumed: it is measured from
 * the two ends, so a steady chain needs only a few reads) and falls back to
 * bisection after a dozen reads, so irregular block times (for example after sequencer downtime) still
 * terminate. Integer math only.
 */
export async function blockAtOrAfter(
  ts: bigint,
  lo: BlockRef,
  hi: BlockRef,
  timeOf: (n: bigint) => Promise<bigint>,
): Promise<bigint> {
  if (hi.time < ts) return hi.number + 1n;
  if (ts <= lo.time) return lo.number;
  let loN = lo.number; // time(loN) < ts
  let loT = lo.time;
  let hiN = hi.number; // time(hiN) >= ts
  let hiT = hi.time;
  for (let i = 0; i < 96; i++) {
    if (hiN - loN <= 1n) return hiN;
    let guess = i < 12 && hiT > loT ? loN + ((ts - loT) * (hiN - loN)) / (hiT - loT) : (loN + hiN) / 2n;
    if (guess <= loN) guess = loN + 1n;
    if (guess >= hiN) guess = hiN - 1n;
    const t = await timeOf(guess);
    if (t >= ts) {
      hiN = guess;
      hiT = t;
    } else {
      loN = guess;
      loT = t;
    }
  }
  throw new HistoryError("Could not locate a block by time.");
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Text of an error and its causes, for classification only (never shown to the user). */
function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && typeof cur === "object" && cur !== null; i++) {
    const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const v of [o.shortMessage, o.details, o.message]) if (typeof v === "string") parts.push(v);
    cur = o.cause;
  }
  return parts.join(" ");
}

/**
 * True when the node refused the block range itself (for example "eth_getLogs is limited to a 200
 * range", JSON-RPC code -32614, HTTP 413), so a smaller range can succeed. Rate limits (429), timeouts
 * and other failures are not range errors: splitting them would only multiply requests.
 */
export function isRangeLimitError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const status = (e as { status?: unknown } | null)?.status;
  if (code === -32614 || status === 413) return true;
  return /block range|limited to a \d+|range (is )?(too|limit)|too large|exceeds? the (max|limit)|more than \d+ (blocks|results)|query returned more than|response size/i.test(
    errorText(e),
  ) && !/rate limit|too many requests|429/i.test(errorText(e));
}

type ScanCtx = {
  budget: { left: number };
  sleep: (ms: number) => Promise<void>;
  retryDelaysMs: readonly number[];
};

const DEFAULT_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One range. A range-limit error splits the range in half (down to a small floor); any other failure
 * (429, timeout, 5xx) is retried a few times with backoff on the same range, then fails with a
 * `HistoryError`, so a rate-limited node is never hammered with ever smaller requests.
 */
async function logsFor(src: HistorySource, id: bigint, from: bigint, to: bigint, ctx: ScanCtx): Promise<RawLog[]> {
  const fail = () => new HistoryError(`Could not read the reveals of round #${id} from the chain.`);
  for (let attempt = 0; ; attempt++) {
    if (ctx.budget.left <= 0) throw new HistoryError("Too many log requests were needed; the history was not loaded.");
    ctx.budget.left -= 1;
    try {
      return await src.getRevealLogs(id, from, to);
    } catch (e) {
      if (isRangeLimitError(e)) {
        const span = to - from + 1n;
        if (span <= MIN_SPLIT_BLOCKS) throw fail();
        const mid = from + span / 2n - 1n;
        const left = await logsFor(src, id, from, mid, ctx);
        const right = await logsFor(src, id, mid + 1n, to, ctx);
        return [...left, ...right];
      }
      const delay = ctx.retryDelaysMs[attempt];
      if (delay === undefined) throw fail();
      await ctx.sleep(delay);
    }
  }
}

/**
 * Loads the rounds whose commit window ends at or after the time of `fromBlock` (at most the most
 * recent `maxRounds`), oldest first, each with its state, contract scores and, for settled rounds,
 * the scored reveals. Reveals are read from logs only inside each round's reveal window, chunked and
 * bounded. Any failure rejects with `HistoryError` (never an empty list); an empty array means no
 * round in range. `source` defaults to Base Sepolia.
 */
export async function loadHistory(
  fromBlock: bigint,
  source?: HistorySource,
  opts: LoadOptions = {},
): Promise<RoundSummary[]> {
  const src = source ?? (await import("./historySource")).createChainSource();
  const chunk = opts.chunkBlocks ?? LOG_CHUNK_BLOCKS;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;

  let head: { number: bigint; time: bigint };
  let fromTime: bigint;
  let count: unknown;
  try {
    head = await src.head();
    if (fromBlock > head.number) return [];
    [fromTime, count] = await Promise.all([src.blockTime(fromBlock), src.roundCount()]);
  } catch {
    throw new HistoryError("Could not read the chain head from Base Sepolia.");
  }
  if (typeof count !== "bigint" || count < 0n) throw new HistoryError("The round count read was malformed.");
  if (count === 0n) return [];

  const first = count > BigInt(maxRounds) ? count - BigInt(maxRounds) + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = first; id <= count; id++) ids.push(id);

  const rawById = new Map<bigint, unknown[]>();
  const rounds: RoundSummary[] = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH);
    let results: unknown[][];
    try {
      results = await src.readRounds(batch);
    } catch {
      throw new HistoryError("Could not read the rounds from Base Sepolia.");
    }
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw new HistoryError("The round reads returned an unexpected shape.");
    }
    batch.forEach((id, n) => {
      const res = Array.isArray(results[n]) ? (results[n] as unknown[]) : [];
      const s = summarizeRound({ id, results: res, reveals: [] });
      rawById.set(id, res);
      if (s.commitEnd !== null && s.commitEnd >= fromTime) rounds.push(s);
    });
  }

  // Reveals of settled rounds, one bounded window at a time. A reveal lands in a block with
  // commitEnd <= timestamp < revealEnd, so the window is that block range (plus one block of margin).
  const timeCache = new Map<bigint, bigint>();
  const timeOf = async (n: bigint) => {
    const hit = timeCache.get(n);
    if (hit !== undefined) return hit;
    const t = await src.blockTime(n);
    timeCache.set(n, t);
    return t;
  };
  const lo: BlockRef = { number: fromBlock, time: fromTime };
  const out: RoundSummary[] = [];
  for (const r of rounds) {
    if (r.state !== "settled" || r.commitEnd === null || r.revealEnd === null) {
      out.push(r);
      continue;
    }
    let reveals: ParsedReveal[];
    try {
      const start = await blockAtOrAfter(r.commitEnd, lo, head, timeOf);
      const end = await blockAtOrAfter(r.revealEnd, { number: start, time: await timeOf(start) }, head, timeOf);
      const from = start > 0n ? start - 1n : 0n;
      const to = end < head.number ? end : head.number;
      const ranges = chunkRanges(from, to, chunk);
      if (ranges.length > MAX_WINDOW_CHUNKS) {
        throw new HistoryError(`The reveal window of round #${r.id} is too large to scan.`);
      }
      const ctx: ScanCtx = {
        budget: { left: MAX_WINDOW_CHUNKS * 4 },
        sleep: opts.sleep ?? realSleep,
        retryDelaysMs: opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      };
      const logs = (await mapLimit(ranges, CONCURRENCY, ([f, t]) => logsFor(src, r.id, f, t, ctx))).flat();
      reveals = [];
      for (const log of logs) {
        const p = parseRevealedLog(log);
        if (p !== null && p.id === r.id) reveals.push(p);
      }
    } catch (e) {
      if (e instanceof HistoryError) throw e;
      throw new HistoryError(`Could not read the reveals of round #${r.id} from the chain.`);
    }
    out.push(summarizeRound({ id: r.id, results: rawById.get(r.id) ?? [], reveals }));
  }
  return out;
}

// ---- Outcome, win rate, gap ----

export type Outcome = "human" | "agent" | "tie" | "none";

/**
 * Who won a round. Only a settled round with both consensus scores and the reveal quorum (>= 3 reveals
 * per side) has a result; equal scores tie.
 */
export function outcomeOf(r: RoundSummary): Outcome {
  if (r.state !== "settled" || r.humanScore === null || r.agentScore === null || !hasQuorum(r)) return "none";
  if (r.humanScore === r.agentScore) return "tie";
  return r.humanScore > r.agentScore ? "human" : "agent";
}

/** Human score minus Agent score in points (-100..100), or null when there is no result (incl. below quorum). */
export function gapOf(r: RoundSummary): number | null {
  if (r.state !== "settled" || r.humanScore === null || r.agentScore === null || !hasQuorum(r)) return null;
  return r.humanScore - r.agentScore;
}

export type Tally = {
  human: number;
  agent: number;
  tie: number;
  void: number;
  open: number;
  /** Settled with scores but a side below the reveal quorum: shown, never counted. */
  belowQuorum: number;
  noResult: number;
};

export function tally(rounds: readonly RoundSummary[]): Tally {
  const t: Tally = { human: 0, agent: 0, tie: 0, void: 0, open: 0, belowQuorum: 0, noResult: 0 };
  for (const r of rounds) {
    if (r.state === "void") t.void += 1;
    else if (r.state === "open") t.open += 1;
    else if (r.state === "settled" && r.reveals !== null && !hasQuorum(r)) t.belowQuorum += 1;
    else {
      const o = outcomeOf(r);
      if (o === "none") t.noResult += 1;
      else t[o] += 1;
    }
  }
  return t;
}

/**
 * Win rate in whole percent (floor) over decided rounds only: void, open, tie, below-quorum, one-sided
 * and unreadable rounds are not counted for either side. Both are 0 when no round was decided (the caller shows the
 * number of decided rounds, so 0 is not read as "lost every round").
 */
export function winRate(rounds: readonly RoundSummary[]): { human: number; agent: number } {
  const t = tally(rounds);
  const decided = t.human + t.agent;
  if (decided === 0) return { human: 0, agent: 0 };
  return { human: Math.floor((t.human * 100) / decided), agent: Math.floor((t.agent * 100) / decided) };
}

// ---- Trend chart geometry (display only) ----

export type TrendBox = { width: number; height: number; padLeft: number; padRight: number; padTop: number; padBottom: number };
export type TrendPoint = { x: number; y: number; gap: number };

/** Pixel positions for gaps in -100..100 (Human score minus Agent score); positive is drawn upward. */
export function trendPoints(gaps: readonly number[], box: TrendBox): { zeroY: number; points: TrendPoint[] } {
  const plotW = box.width - box.padLeft - box.padRight;
  const plotH = box.height - box.padTop - box.padBottom;
  const yOf = (g: number) => box.padTop + Math.round(((100 - g) * plotH) / 200);
  const n = gaps.length;
  const points = gaps.map((raw, i) => {
    const gap = Math.max(-100, Math.min(100, Math.trunc(raw)));
    const x = n === 1 ? box.padLeft + Math.round(plotW / 2) : box.padLeft + Math.round((i * plotW) / (n - 1));
    return { x, y: yOf(gap), gap };
  });
  return { zeroY: yOf(0), points };
}

// ---- Leaderboard ----

export type LeaderRow = {
  who: string;
  kind: 1 | 2;
  /** True only when the address is on the project's published house agent list. */
  house: boolean;
  rounds: number;
  best: number;
  sum: number;
  /** Average score times 10, floored (integer math): 750 means 75.0. */
  avg10: number;
};

/**
 * Ranks every revealed entry of the settled rounds by average score (exact comparison by cross
 * multiplication, ties by rounds played then address). Entries of void or unreadable rounds do not
 * count. Rows are per address and kind. Agents stay labeled as agents; `house` is set only by the address list.
 */
export function buildLeaderboard(rounds: readonly RoundSummary[], houseAgents: ReadonlySet<string>): LeaderRow[] {
  const acc = new Map<string, { who: string; kind: 1 | 2; rounds: number; best: number; sum: number }>();
  const ordered = [...rounds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of ordered) {
    if (r.state !== "settled") continue;
    for (const e of r.entries) {
      // One row per address and kind: an address reclassified between rounds shows two rows, so a
      // Human score is never averaged into an Agent row (or the reverse).
      const key = `${e.who.toLowerCase()}|${e.kind}`;
      const row = acc.get(key);
      if (row === undefined) acc.set(key, { who: e.who, kind: e.kind, rounds: 1, best: e.score, sum: e.score });
      else {
        row.rounds += 1;
        row.sum += e.score;
        row.best = Math.max(row.best, e.score);
      }
    }
  }
  const rows: LeaderRow[] = [...acc.values()].map((v) => ({
    ...v,
    house: houseAgents.has(v.who.toLowerCase()),
    avg10: Math.floor((v.sum * 10) / v.rounds),
  }));
  rows.sort((a, b) => {
    const lhs = a.sum * b.rounds;
    const rhs = b.sum * a.rounds;
    if (lhs !== rhs) return rhs - lhs;
    if (a.rounds !== b.rounds) return b.rounds - a.rounds;
    if (a.who.toLowerCase() !== b.who.toLowerCase()) return a.who.toLowerCase() < b.who.toLowerCase() ? -1 : 1;
    return a.kind - b.kind;
  });
  return rows;
}

/**
 * The project's house agent addresses from the deployment file (`houseAgents`, optional). Checksums are
 * enforced (a typo must not silently lose the `house` label) and duplicates are merged. A bad list
 * returns an error to show, with no addresses.
 */
export function parseHouseAgents(raw: unknown): { addresses: Set<string>; error: string | null } {
  const bad = { addresses: new Set<string>(), error: "The house agent address list is invalid, so house labels are unavailable." };
  if (raw === undefined) return { addresses: new Set(), error: null };
  if (!Array.isArray(raw)) return bad;
  const out = new Set<string>();
  for (const a of raw as unknown[]) {
    if (typeof a !== "string" || !isAddress(a, { strict: true })) return bad;
    out.add(a.toLowerCase());
  }
  return { addresses: out, error: null };
}

// ---- Replay (shares the reveal screen's frame generator) ----

export type ReplayProps = {
  real: Path;
  human: Path | null;
  agent: Path | null;
  T: number;
  onchain?: ConsensusScores;
  baseline?: number;
  sourceHash?: string;
};

/**
 * Inputs of the reveal player for a settled round, built the way the live reveal page builds them. A
 * simulated round gets no `onchain` and no `sourceHash`, so the player cannot claim a match with the
 * chain or a keeper post. Null unless the round is settled and its reads validated.
 */
export function replayProps(r: RoundSummary): ReplayProps | null {
  if (r.state !== "settled" || r.reads === null) return null;
  const { reads } = r;
  return {
    real: reads.real,
    human: reads.human,
    agent: reads.agent,
    T: r.T,
    ...(!r.simulated && reads.scores ? { onchain: reads.scores } : {}),
    ...(reads.baseline !== undefined ? { baseline: reads.baseline } : {}),
    ...(!r.simulated ? { sourceHash: reads.sourceHash } : {}),
  };
}

/** Frames 0..3 of the replay, from the same `revealFrame` the live reveal uses. Empty if not replayable. */
export function replayFrames(r: RoundSummary): RevealFrame[] {
  const p = replayProps(r);
  if (p === null) return [];
  return Array.from({ length: STEP_COUNT + 1 }, (_, step) =>
    revealFrame({ real: p.real, human: p.human, agent: p.agent, T: p.T }, step),
  );
}

// ---- Simulated sample (explicit, labeled, never mixed with chain rows) ----

/** A valid path from closes and wick extensions beyond the body (all integers, bp from P0). */
function mkPath(closes: readonly [number, number, number], up: readonly [number, number, number], down: readonly [number, number, number]): Path {
  const candles = closes.map((close, i) => {
    const open = i === 0 ? 0 : (closes[i - 1] as number);
    return { close, high: Math.max(open, close) + (up[i] as number), low: Math.min(open, close) - (down[i] as number) };
  });
  return candles as unknown as Path;
}

const SIM_HASH = `0x${"00".repeat(32)}`;
const SIM_T = 50;
const FLAT: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];

type SimSpec = {
  state: "settled" | "void";
  real: Path;
  human: Path;
  agent: Path;
  humanEntries: readonly Path[];
  agentEntries: readonly Path[];
};

function simSpec(realCloses: [number, number, number], humanCloses: [number, number, number], agentCloses: [number, number, number]): SimSpec {
  const real = mkPath(realCloses, [8, 6, 10], [5, 9, 4]);
  const human = mkPath(humanCloses, [6, 6, 6], [6, 6, 6]);
  const agent = mkPath(agentCloses, [6, 6, 6], [6, 6, 6]);
  const wobble = (c: [number, number, number], d: number): [number, number, number] => [c[0] + d, c[1] - d, c[2] + 2 * d];
  return {
    state: "settled",
    real,
    human,
    agent,
    humanEntries: [mkPath(wobble(humanCloses, 4), [5, 5, 5], [5, 5, 5]), mkPath(wobble(humanCloses, -6), [7, 7, 7], [4, 4, 4]), mkPath(wobble(humanCloses, 11), [3, 3, 3], [9, 9, 9])],
    agentEntries: [
      mkPath(wobble(agentCloses, 2), [5, 5, 5], [5, 5, 5]),
      mkPath(wobble(agentCloses, -3), [6, 6, 6], [6, 6, 6]),
      mkPath(wobble(agentCloses, 7), [4, 4, 4], [8, 8, 8]),
    ],
  };
}

const SIM_SPECS: readonly SimSpec[] = [
  simSpec([12, 20, 31], [10, 25, 28], [20, 10, 35]),
  simSpec([-9, -18, -30], [-12, -20, -25], [8, -4, -10]),
  simSpec([5, -6, 14], [14, 2, 8], [6, -4, 12]),
  { ...simSpec([0, 0, 0], [0, 0, 0], [0, 0, 0]), state: "void" },
  simSpec([18, 22, 40], [16, 20, 30], [16, 20, 30]), // identical consensus: a tie
  simSpec([-4, 10, 26], [-10, 6, 20], [-2, 12, 30]),
  // Only 2 human reveals: below the quorum, so it is shown but not counted.
  { ...simSpec([7, 3, 15], [9, 5, 12], [2, 8, 11]), humanEntries: simSpec([7, 3, 15], [9, 5, 12], [2, 8, 11]).humanEntries.slice(0, 2) },
];

/**
 * Deterministic sample rounds for demos and screenshots. Every row has `simulated: true`; scores are
 * computed with the shared `score` over made-up paths, so they are internally consistent but do NOT
 * come from the chain. Only the dashboard's explicit sample mode may show them, and never next to chain rows.
 */
export function simulatedRounds(): RoundSummary[] {
  return SIM_SPECS.map((spec, i): RoundSummary => {
    const id = BigInt(i + 1);
    const base = { id, ticker: "SAMPLE", T: SIM_T, commitEnd: null, revealEnd: null, simulated: true as const };
    if (spec.state === "void") {
      return { ...base, state: "void", humanScore: null, agentScore: null, baseline: null, reads: null, entries: [], reveals: null };
    }
    const humanScore = score(spec.human, spec.real, SIM_T);
    const agentScore = score(spec.agent, spec.real, SIM_T);
    const baseline = score(FLAT, spec.real, SIM_T);
    const entries: RoundEntry[] = [
      ...spec.humanEntries.map((p, n) => ({ who: `sample-human-${n + 1}`, kind: 1 as const, score: score(p, spec.real, SIM_T) })),
      ...spec.agentEntries.map((p, n) => ({ who: `sample-agent-${n + 1}`, kind: 2 as const, score: score(p, spec.real, SIM_T) })),
    ];
    return {
      ...base,
      state: "settled",
      humanScore,
      agentScore,
      baseline,
      reads: {
        real: spec.real,
        sourceHash: SIM_HASH,
        human: spec.human,
        agent: spec.agent,
        scores: { human: humanScore, agent: agentScore, humanPresent: true, agentPresent: true },
        baseline,
      },
      entries,
      reveals: {
        human: spec.humanEntries.length,
        agent: spec.agentEntries.length,
      },
    };
  });
}
