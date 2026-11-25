// The round loop: opens rounds, calls `freezeAll` right after `revealEnd`, posts the real candles after
// `marketEnd + 3*candleSec`, and logs a missed `settleDeadline`.
//
// Safety model
//  - Single-flight: at most one `tick` runs at a time (a second call returns the running one) and the timer
//    only re-arms after a tick has finished. Every chain send also goes through the shared send lock.
//  - "Now" is the latest block timestamp in SECONDS (what the contract compares against).
//  - The round config is persisted (stage "planned") BEFORE `openRound` is sent. After a restart the loop
//    first scans `RoundOpened` logs from the stored block for that exact config and only then sends again,
//    and `openRound` itself dedups an identical tuple.
//  - Ticker, `marketEnd` and p0 used to build the candles come from ONE `getRound(id)` read of the id being
//    settled, and that read is also compared with the persisted config (a mismatch stops the round).
//  - `POSTED_DIFFERENT` is terminal and persisted: it is never retried, not even after a restart.
//  - No data from the feed means no post. The round then voids by itself (anyone can call `voidRound`
//    after `settleDeadline`; that is not the keeper's job, the keeper only raises an alert).
//  - Only bp moves relative to P0 are posted or logged. No price ever reaches a log line.
import { Mutex } from "./lock";
import { createLoopOps, type LoopOps, type RoundOnChain } from "./ops";
import { KeeperError, type KeeperDeps, type RoundConfig } from "./rounds";
import {
  DataError,
  BAR_SEC,
  barsToCandles,
  planRound,
  sourceUrlFor,
  type PriceFeed,
  type RoundTemplate,
} from "./source";
import { deserializeConfig, serializeConfig, type KeeperState, type Outcome, type Stage, type StateStore, type StoredRound } from "./state";

export interface LoopConfig {
  /** Real clients. Used to build `ops` (and the chain id / arena for the state file) when `ops` is not given. */
  deps?: KeeperDeps;
  /** Send lock shared with the relay. */
  lock?: Mutex;
  /** Injected chain operations (tests). Requires `chainId` and `arena`. */
  ops?: LoopOps;
  chainId?: number;
  arena?: string;
  feed: PriceFeed;
  store: StateStore;
  template: RoundTemplate;
  /** Open a new round when this returns true and no round is active. Default: `minGapSec` after the last round's candles. */
  openPolicy?: (ctx: { now: number; state: KeeperState }) => boolean;
  /** Stop planning new rounds after this many (demo: 1). */
  maxRounds?: number;
  /** Seconds between the end of the candles and the next open for the default policy. Default 60. */
  minGapSec?: number;
  /** Timer period; 0 = no timer, drive `handle.tick()` yourself. Default 5000. */
  tickMs?: number;
  /** Wait this long after `marketEnd + 3*candleSec` before asking the feed for the last bars. Default 15. */
  dataDelaySec?: number;
  /** Anvil only: mine a block each tick so chain time advances without `--block-time`. */
  mineOnTick?: boolean;
  log?: (msg: string) => void;
  /** Called for conditions a human must see (missed deadline, terminal mismatch). Default: stderr. */
  alert?: (msg: string) => void;
}

export interface LoopHandle {
  /** Runs one pass; if a pass is already running, returns that one (single-flight). */
  tick(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves once `maxRounds` rounds were planned and all rounds are done. Never resolves without `maxRounds`. */
  readonly finished: Promise<void>;
  state(): KeeperState;
}

/** Re-reads the stage (TypeScript narrows it across awaited calls that mutate the record). */
const stageOf = (r: StoredRound): Stage => r.stage;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function startLoop(cfg: LoopConfig): Promise<LoopHandle> {
  const lock = cfg.lock ?? new Mutex();
  const ops: LoopOps = cfg.ops ?? (cfg.deps ? createLoopOps(cfg.deps, lock) : (undefined as never));
  if (!ops) throw new Error("startLoop: pass `deps` or `ops`");
  const chainId = cfg.deps?.chainId ?? cfg.chainId;
  const arena = cfg.deps?.arenaAddress ?? cfg.arena;
  if (chainId === undefined || !arena) throw new Error("startLoop: chainId and arena are required");
  if (cfg.mineOnTick && chainId !== 31337) throw new Error("startLoop: mineOnTick is only allowed on the local anvil chain");
  const log = cfg.log ?? ((m: string) => console.log(`[loop] ${m}`));
  const alert = cfg.alert ?? ((m: string) => console.error(`[ALERT] ${m}`));
  const dataDelay = cfg.dataDelaySec ?? 15;
  const minGap = cfg.minGapSec ?? 60;
  const tickMs = cfg.tickMs ?? 5000;

  // Refuse to run with a key that is not the Arena keeper: every send would revert.
  await ops.verifyKeeper();
  const state = cfg.store.load(chainId, arena);
  log(`started: ${state.rounds.length} round(s) in the state file, ${state.rounds.filter((r) => r.stage !== "done").length} active`);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  const save = (): void => cfg.store.save(state);

  const finish = (rec: StoredRound, outcome: Outcome, note: string): void => {
    rec.stage = "done";
    rec.outcome = outcome;
    save();
    log(`round #${rec.seq}${rec.id ? ` (id ${rec.id})` : ""} done: ${outcome}${note ? ` (${note})` : ""}`);
  };

  /** planned -> open: recover the id from logs, otherwise send `openRound` (which dedups an identical tuple). */
  async function resolveOpen(rec: StoredRound, now: number): Promise<void> {
    const rc: RoundConfig = deserializeConfig(rec.cfg);
    let id: bigint | undefined;
    try {
      id = await ops.recoverRoundId(rc, BigInt(rec.fromBlock));
    } catch (e) {
      log(`round #${rec.seq}: log scan failed (${errMsg(e)}); will retry`);
      return;
    }
    if (id !== undefined) {
      log(`round #${rec.seq}: found on chain as id ${id} (already opened)`);
    } else {
      try {
        id = await ops.openRound(rc);
      } catch (e) {
        if (e instanceof KeeperError && e.code === "BAD_ROUND") {
          finish(rec, "open_failed", errMsg(e));
          return;
        }
        log(`round #${rec.seq}: openRound failed (${errMsg(e)}); will retry while the commit window is open (now=${now})`);
        return;
      }
    }
    rec.id = id.toString();
    rec.stage = "open";
    save();
    log(`round #${rec.seq}: open as id ${id}`);
  }

  const sameRound = (r: RoundOnChain, c: RoundConfig): boolean =>
    r.ticker === c.ticker &&
    r.p0 === c.p0 &&
    r.T === c.T &&
    r.commitEnd === c.commitEnd &&
    r.revealEnd === c.revealEnd &&
    r.marketEnd === c.marketEnd &&
    r.candleSec === c.candleSec &&
    r.settleDeadline === c.settleDeadline &&
    r.entryStake === c.entryStake;

  async function advance(rec: StoredRound, now: number): Promise<void> {
    const id = BigInt(rec.id as string);
    const r = await ops.getRound(id); // the single read every later step of this round uses
    if (!sameRound(r, deserializeConfig(rec.cfg))) {
      alert(`round #${rec.seq}: on-chain round ${id} differs from the config the keeper opened; stopping work on it`);
      finish(rec, "id_mismatch", "");
      return;
    }

    if (now >= r.revealEnd && rec.stage === "open") {
      try {
        await ops.freezeAll(id);
        rec.stage = "frozen";
        save();
      } catch (e) {
        log(`round ${id}: freezeAll failed (${errMsg(e)}); will retry`);
      }
    }

    const candlesEnd = r.marketEnd + 3 * r.candleSec;
    if (now < candlesEnd) return;

    if (await ops.settled(id)) {
      finish(rec, "settled", "");
      return;
    }
    if (now > r.settleDeadline) {
      if (!rec.missedAlerted) {
        rec.missedAlerted = true;
        alert(`round ${id}: settleDeadline ${r.settleDeadline} passed without candles; the round is void (anyone can call voidRound; the keeper does not)`);
      }
      finish(rec, "missed_deadline", "");
      return;
    }
    if (now < candlesEnd + dataDelay) return;

    // One code path: ticker, window start and p0 all come from `r`.
    try {
      const bars = await cfg.feed.bars(r.ticker, r.marketEnd, candlesEnd, BAR_SEC);
      if (bars.length === 0) throw new DataError("NO_DATA", "the feed returned no bars");
      const real = barsToCandles(bars, r.p0, r.marketEnd, r.candleSec);
      await ops.postCandles(id, real, sourceUrlFor(cfg.feed, r.marketEnd, candlesEnd));
      finish(rec, "settled", "");
    } catch (e) {
      if (e instanceof KeeperError && e.code === "POSTED_DIFFERENT") {
        alert(`round ${id}: candles were already posted with different data; terminal, not retrying`);
        finish(rec, "posted_different", "");
      } else if (e instanceof KeeperError && (e.code === "WINDOW_CLOSED" || e.code === "ROUND_VOID")) {
        alert(`round ${id}: ${e.code}; candles can no longer be posted`);
        finish(rec, "missed_deadline", e.code);
      } else if (e instanceof DataError) {
        log(`round ${id}: not posting (${e.code}: ${e.message}); will retry until settleDeadline`);
      } else {
        log(`round ${id}: postCandles did not complete (${errMsg(e)}); will retry`);
      }
    }
  }

  async function planNext(now: number): Promise<void> {
    if (stopped) return;
    if (state.rounds.some((r) => r.stage !== "done")) return;
    if (cfg.maxRounds !== undefined && state.rounds.length >= cfg.maxRounds) return;
    const last = state.rounds[state.rounds.length - 1];
    const policy =
      cfg.openPolicy ??
      (({ now: n }: { now: number }) => !last || n >= last.cfg.marketEnd + 3 * last.cfg.candleSec + minGap);
    if (!policy({ now, state })) return;

    let rc: RoundConfig;
    try {
      rc = await planRound(cfg.template, cfg.feed, now);
    } catch (e) {
      log(`not opening a round: ${errMsg(e)}`);
      return;
    }
    const fromBlock = (await ops.blockNumber()).toString();
    const rec: StoredRound = { seq: (last?.seq ?? 0) + 1, cfg: serializeConfig(rc), fromBlock, stage: "planned" };
    state.rounds.push(rec);
    save(); // persisted BEFORE anything is sent
    log(`round #${rec.seq}: planned (commitEnd ${rc.commitEnd}, T ${rc.T} bp)`);
    await resolveOpen(rec, now);
  }

  async function tickOnce(): Promise<void> {
    if (stopped) return;
    let now: number;
    try {
      if (cfg.mineOnTick) await ops.mine?.();
      now = await ops.chainNow();
    } catch (e) {
      log(`cannot read chain time (${errMsg(e)}); skipping this tick`);
      return;
    }
    for (const rec of state.rounds) {
      if (rec.stage === "done") continue;
      try {
        if (stageOf(rec) === "planned") await resolveOpen(rec, now);
        if (stageOf(rec) !== "planned" && stageOf(rec) !== "done" && rec.id) await advance(rec, now);
      } catch (e) {
        log(`round #${rec.seq}: step failed (${errMsg(e)}); will retry`);
      }
    }
    try {
      await planNext(now);
    } catch (e) {
      log(`planning failed (${errMsg(e)}); will retry`);
    }
    if (cfg.maxRounds !== undefined && state.rounds.length >= cfg.maxRounds && state.rounds.every((r) => r.stage === "done")) {
      resolveFinished();
    }
  }

  const tick = (): Promise<void> => {
    if (running) return running;
    running = tickOnce().finally(() => {
      running = undefined;
    });
    return running;
  };

  const arm = (): void => {
    if (stopped || tickMs <= 0) return;
    timer = setTimeout(() => {
      void tick().finally(arm);
    }, tickMs);
  };
  arm();

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
    finished,
    state: () => state,
  };
}
