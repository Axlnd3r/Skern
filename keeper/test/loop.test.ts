// Scheduler tests with a fake chain: single-flight, persistence before send, restart recovery, freezeAll timing,
// the missed-settleDeadline alert, terminal POSTED_DIFFERENT, no data, licence-safe logs.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startLoop, type LoopConfig, type LoopHandle } from "../src/loop";
import type { LoopOps, RoundOnChain } from "../src/ops";
import { KeeperError, type RoundConfig } from "../src/rounds";
import { demoTemplate } from "../src/demo";
import type { Bar } from "../src/candles";
import type { PriceFeed } from "../src/source";
import { FileStateStore, MemoryStateStore, deserializeConfig, serializeConfig } from "../src/state";
import type { Path } from "../../shared/score";

const T0 = 1_800_000_000; // divisible by 60 and 300
const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PRICE = 123.4567; // distinctive: it must never show up in a log line
const LEVELS = [123.5802, 123.7654, 123.6419]; // about +10, +25, +15 bp of PRICE

/** A fake Arena: just enough state for the loop. */
function fakeChain(store?: MemoryStateStore) {
  const s = {
    now: T0,
    block: 100n,
    rounds: new Map<bigint, RoundOnChain>(),
    settled: new Set<bigint>(),
    frozen: new Set<bigint>(),
    calls: [] as string[],
    posts: [] as { id: bigint; real: Path; url: string }[],
    openSnapshots: [] as unknown[],
    failOpenWith: undefined as Error | undefined,
    failPostWith: undefined as Error | undefined,
    failFreeze: false,
    chainNowGate: undefined as Promise<void> | undefined,
    chainNowCalls: 0,
  };
  const fromCfg = (c: RoundConfig): RoundOnChain => ({ ...c });
  const ops: LoopOps = {
    async verifyKeeper() {
      s.calls.push("verify");
    },
    async chainNow() {
      s.chainNowCalls++;
      if (s.chainNowGate) await s.chainNowGate;
      return s.now;
    },
    async blockNumber() {
      return s.block;
    },
    async mine() {
      s.calls.push("mine");
      s.now += 1;
    },
    async openRound(cfg) {
      s.calls.push("openRound");
      // what was on disk at the moment the send happens
      if (store) s.openSnapshots.push(store.load(31337, ARENA));
      if (s.failOpenWith) throw s.failOpenWith;
      const id = BigInt(s.rounds.size + 1);
      s.rounds.set(id, fromCfg(cfg));
      return id;
    },
    async recoverRoundId(cfg) {
      s.calls.push("recover");
      for (const [id, r] of s.rounds) {
        if (r.ticker === cfg.ticker && r.p0 === cfg.p0 && r.commitEnd === cfg.commitEnd && r.T === cfg.T) return id;
      }
      return undefined;
    },
    async getRound(id) {
      const r = s.rounds.get(id);
      if (!r) throw new Error("unknown round");
      return r;
    },
    async settled(id) {
      return s.settled.has(id);
    },
    async isVoid() {
      return false;
    },
    async isFrozen(id) {
      return s.frozen.has(id);
    },
    async freezeAll(id) {
      s.calls.push(`freezeAll:${id}`);
      if (s.failFreeze) throw new Error("freeze failed");
      s.frozen.add(id);
    },
    async postCandles(id, real, url) {
      s.calls.push(`postCandles:${id}`);
      if (s.failPostWith) throw s.failPostWith;
      s.posts.push({ id, real, url });
      s.settled.add(id);
    },
  };
  return { s, ops };
}

interface FeedCall {
  ticker: string;
  from: number;
  to: number;
}

/** History is flat at PRICE; from `windowStart` on the three candles sit on LEVELS. `online=false` returns no bars. */
function fakeFeed(state: { windowStart?: number; online: boolean; calls: FeedCall[] }): PriceFeed {
  return {
    mode: "live",
    attributionBase: "https://alpaca.markets/data",
    attributionParams: { feed: "iex" },
    async bars(ticker, from, to) {
      state.calls.push({ ticker, from, to });
      if (!state.online) return [];
      const out: Bar[] = [];
      for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) {
        const idx = state.windowStart !== undefined && t >= state.windowStart ? Math.floor((t - state.windowStart) / 300) : -1;
        const p = idx >= 0 ? (LEVELS[idx] as number) : PRICE;
        out.push({ t, open: p, high: p, low: p, close: p });
      }
      return out;
    },
  };
}

async function mkLoop(over: Partial<LoopConfig> = {}, store = new MemoryStateStore()) {
  const chain = fakeChain(store);
  const feedState = { online: true, calls: [] as FeedCall[], windowStart: undefined as number | undefined };
  const logs: string[] = [];
  const alerts: string[] = [];
  const handles: LoopHandle[] = [];
  const start = async (extra: Partial<LoopConfig> = {}, s = store) => {
    const h = await startLoop({
      ops: chain.ops,
      chainId: 31337,
      arena: ARENA,
      feed: fakeFeed(feedState),
      store: s,
      template: demoTemplate({ leadSec: 0 }),
      tickMs: 0,
      dataDelaySec: 15,
      log: (m) => logs.push(m),
      alert: (m) => alerts.push(m),
      ...over,
      ...extra,
    });
    handles.push(h);
    return h;
  };
  return { chain, feedState, logs, alerts, store, start, handles };
}

describe("round loop", () => {
  it("persists the config BEFORE sending openRound, then records the id", async () => {
    const { chain, store, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    expect(chain.s.calls.filter((c) => c === "openRound").length).toBe(1);
    const snap = chain.s.openSnapshots[0] as { rounds: { stage: string; id?: string; cfg: { ticker: string; p0: string } }[] };
    expect(snap.rounds.length).toBe(1);
    expect(snap.rounds[0]).toMatchObject({ stage: "planned", cfg: { ticker: "AAPL", p0: "123456700" } });
    expect(snap.rounds[0]?.id).toBeUndefined();
    const saved = store.load(31337, ARENA);
    expect(saved.rounds[0]).toMatchObject({ stage: "open", id: "1" });
    expect(saved.rounds[0]?.fromBlock).toBe("100");
  });

  it("does not open a second round while one is active", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    await loop.tick();
    await loop.tick();
    expect(chain.s.calls.filter((c) => c === "openRound").length).toBe(1);
  });

  it("calls freezeAll once, right after revealEnd and not before", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    chain.s.now = r.revealEnd - 1;
    await loop.tick();
    expect(chain.s.calls.some((c) => c.startsWith("freezeAll"))).toBe(false);
    chain.s.now = r.revealEnd;
    await loop.tick();
    expect(chain.s.calls.filter((c) => c === "freezeAll:1").length).toBe(1);
    chain.s.now = r.revealEnd + 5;
    await loop.tick();
    await loop.tick();
    expect(chain.s.calls.filter((c) => c === "freezeAll:1").length).toBe(1);
    expect(loop.state().rounds[0]?.stage).toBe("frozen");
  });

  it("a failed freezeAll is retried on the next tick", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    chain.s.now = r.revealEnd + 1;
    chain.s.failFreeze = true;
    await loop.tick();
    expect(loop.state().rounds[0]?.stage).toBe("open");
    chain.s.failFreeze = false;
    await loop.tick();
    expect(loop.state().rounds[0]?.stage).toBe("frozen");
    expect(chain.s.calls.filter((c) => c === "freezeAll:1").length).toBe(2);
  });

  it("posts the real candles after marketEnd + 3*candleSec + data delay, using ticker, start and p0 of getRound", async () => {
    const { chain, feedState, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    const candlesEnd = r.marketEnd + 900;
    feedState.calls.length = 0;

    chain.s.now = candlesEnd + 14; // inside the data delay
    await loop.tick();
    expect(chain.s.posts.length).toBe(0);
    expect(feedState.calls.length).toBe(0); // the feed is not even asked yet

    chain.s.now = candlesEnd + 15;
    await loop.tick();
    expect(feedState.calls).toEqual([{ ticker: r.ticker, from: r.marketEnd, to: candlesEnd }]);
    expect(chain.s.posts.length).toBe(1);
    const post = chain.s.posts[0]!;
    expect(post.id).toBe(1n);
    expect(post.real.map((c) => c.close)).toEqual([10, 25, 15]);
    expect(post.url).toBe(`https://alpaca.markets/data?feed=iex&mode=live&from=${r.marketEnd}&to=${candlesEnd}`);
    expect(loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "settled" });
    // the round is done: later ticks do nothing more for it
    await loop.tick();
    expect(chain.s.posts.length).toBe(1);
  });

  it("stops work on a round whose on-chain parameters differ from what the keeper opened", async () => {
    const { chain, feedState, alerts, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    chain.s.rounds.set(1n, { ...r, p0: r.p0 + 1n });
    feedState.windowStart = r.marketEnd;
    feedState.calls.length = 0;
    chain.s.now = r.marketEnd + 900 + 20;
    await loop.tick();
    expect(chain.s.posts.length).toBe(0);
    expect(feedState.calls.length).toBe(0);
    expect(loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "id_mismatch" });
    expect(alerts.join("\n")).toMatch(/differs/);
  });

  it("no data from the feed: nothing is posted, the loop keeps trying, then posts when data appears", async () => {
    const { chain, feedState, logs, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.now = r.marketEnd + 900 + 30;
    feedState.online = false;
    await loop.tick();
    await loop.tick();
    expect(chain.s.posts.length).toBe(0);
    expect(loop.state().rounds[0]?.stage).not.toBe("done");
    expect(logs.join("\n")).toMatch(/not posting \(NO_DATA/);
    feedState.online = true;
    await loop.tick();
    expect(chain.s.posts.length).toBe(1);
  });

  it("a missed settleDeadline raises one alert and is not retried; the keeper never voids", async () => {
    const { chain, feedState, alerts, start, store } = await mkLoop();
    const loop = await start({ maxRounds: 1 });
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.online = false;
    chain.s.now = r.settleDeadline + 1;
    feedState.calls.length = 0;
    await loop.tick();
    await loop.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/settleDeadline/);
    expect(chain.s.posts.length).toBe(0);
    expect(feedState.calls.length).toBe(0);
    expect(chain.s.calls.some((c) => /void/i.test(c))).toBe(false);
    expect(loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "missed_deadline" });
    // after a restart nothing is alerted or posted again
    const second = await mkLoopAgain(chain, store);
    await second.loop.tick();
    expect(second.alerts.length).toBe(0);
    expect(chain.s.posts.length).toBe(0);
  });

  it("settled by someone else or by an earlier run: the round is closed without sending anything", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    chain.s.settled.add(1n);
    chain.s.now = r.marketEnd + 901;
    await loop.tick();
    expect(chain.s.posts.length).toBe(0);
    expect(loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "settled" });
  });

  it("POSTED_DIFFERENT is terminal: raised once, never retried, not even after a restart", async () => {
    const { chain, feedState, alerts, start, store } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.failPostWith = new KeeperError("POSTED_DIFFERENT", "already settled with different candles");
    chain.s.now = r.marketEnd + 900 + 20;
    await loop.tick();
    await loop.tick();
    await loop.tick();
    expect(chain.s.calls.filter((c) => c.startsWith("postCandles")).length).toBe(1);
    expect(alerts.length).toBe(1);
    expect(loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "posted_different" });
    const again = await mkLoopAgain(chain, store);
    await again.loop.tick();
    await again.loop.tick();
    expect(chain.s.calls.filter((c) => c.startsWith("postCandles")).length).toBe(1);
  });

  it("other post failures are retried on the next tick", async () => {
    const { chain, feedState, start } = await mkLoop();
    const loop = await start();
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.now = r.marketEnd + 900 + 20;
    chain.s.failPostWith = new KeeperError("SEND_UNCERTAIN", "no receipt");
    await loop.tick();
    expect(loop.state().rounds[0]?.stage).not.toBe("done");
    chain.s.failPostWith = undefined;
    await loop.tick();
    expect(chain.s.posts.length).toBe(1);
  });

  it("maxRounds: after the round is done no new one opens, and `finished` resolves", async () => {
    const { chain, feedState, start } = await mkLoop();
    const loop = await start({ maxRounds: 1 });
    let finished = false;
    void loop.finished.then(() => (finished = true));
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.now = r.marketEnd + 900 + 20;
    await loop.tick();
    await loop.tick();
    await Promise.resolve();
    expect(finished).toBe(true);
    expect(chain.s.calls.filter((c) => c === "openRound").length).toBe(1);
    expect(loop.state().rounds.length).toBe(1);
  });

  it("without maxRounds a new round opens only after the gap that follows the previous candles", async () => {
    const { chain, feedState, start } = await mkLoop();
    const loop = await start({ minGapSec: 120 });
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.now = r.marketEnd + 900 + 20;
    await loop.tick(); // settles round 1
    expect(loop.state().rounds[0]?.stage).toBe("done");
    expect(chain.s.rounds.size).toBe(1);
    chain.s.now = r.marketEnd + 900 + 119;
    await loop.tick();
    expect(chain.s.rounds.size).toBe(1);
    chain.s.now = r.marketEnd + 900 + 120;
    feedState.windowStart = undefined;
    await loop.tick();
    expect(chain.s.rounds.size).toBe(2);
  });

  it("does not open a round when the feed has no data, and writes no state for it", async () => {
    const { chain, feedState, logs, store, start } = await mkLoop();
    feedState.online = false;
    const loop = await start();
    await loop.tick();
    expect(chain.s.calls).not.toContain("openRound");
    expect(store.saves).toBe(0);
    expect(logs.join("\n")).toMatch(/not opening a round/);
  });
});

/** A second loop on the SAME fake chain and the same store: a process restart. */
async function mkLoopAgain(chain: ReturnType<typeof fakeChain>, store: MemoryStateStore) {
  const alerts: string[] = [];
  const loop = await startLoop({
    ops: chain.ops,
    chainId: 31337,
    arena: ARENA,
    feed: fakeFeed({ online: false, calls: [], windowStart: undefined }),
    store,
    template: demoTemplate({ leadSec: 0 }),
    tickMs: 0,
    log: () => {},
    alert: (m) => alerts.push(m),
    maxRounds: 1,
  });
  return { loop, alerts };
}

describe("single-flight", () => {
  it("a second tick while one is running returns the running one and does no second pass", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    let release!: () => void;
    chain.s.chainNowGate = new Promise<void>((r) => (release = r));
    const a = loop.tick();
    const b = loop.tick();
    expect(b).toBe(a);
    release();
    await Promise.all([a, b]);
    expect(chain.s.chainNowCalls).toBe(1);
    expect(chain.s.calls.filter((c) => c === "openRound").length).toBe(1);
    chain.s.chainNowGate = undefined;
    await loop.tick(); // a later tick runs again
    expect(chain.s.chainNowCalls).toBe(2);
  });

  it("the timer never overlaps passes: it re-arms only after a pass finished", async () => {
    vi.useFakeTimers();
    try {
      const { chain, start } = await mkLoop();
      let release!: () => void;
      chain.s.chainNowGate = new Promise<void>((r) => (release = r));
      const loop = await start({ tickMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000); // first pass starts and blocks
      await vi.advanceTimersByTimeAsync(5000); // many periods pass while it is blocked
      expect(chain.s.chainNowCalls).toBe(1);
      chain.s.chainNowGate = undefined;
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(chain.s.chainNowCalls).toBeGreaterThanOrEqual(2);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() waits for the running pass and no further pass starts", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start();
    let release!: () => void;
    chain.s.chainNowGate = new Promise<void>((r) => (release = r));
    const p = loop.tick();
    let stopped = false;
    const s = loop.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([p, s]);
    expect(stopped).toBe(true);
    chain.s.chainNowGate = undefined;
    const before = chain.s.chainNowCalls;
    await loop.tick();
    expect(chain.s.chainNowCalls).toBe(before);
  });
});

describe("restart recovery", () => {
  it("a round that was mined but whose id was lost is found again (no second openRound)", async () => {
    const m = await mkLoop();
    // First run: openRound is sent and mined, but the process dies before the id is saved.
    const first = await m.start();
    await first.tick();
    expect(m.chain.s.rounds.size).toBe(1);
    const saved = m.store.load(31337, ARENA);
    const rec = saved.rounds[0]!;
    delete rec.id;
    rec.stage = "planned";
    m.store.save(saved);
    m.chain.s.calls.length = 0;

    const second = await mkLoopAgain(m.chain, m.store);
    await second.loop.tick();
    expect(m.chain.s.calls).toContain("recover");
    expect(m.chain.s.calls).not.toContain("openRound");
    expect(m.chain.s.rounds.size).toBe(1);
    expect(second.loop.state().rounds[0]).toMatchObject({ stage: "open", id: "1" });
  });

  it("a planned round that was never sent is opened with the SAME persisted config, not a fresh one", async () => {
    const m = await mkLoop();
    m.chain.s.failOpenWith = new KeeperError("SIMULATION", "rpc down");
    const first = await m.start();
    await first.tick();
    const persisted = m.store.load(31337, ARENA).rounds[0]!;
    expect(persisted.stage).toBe("planned");
    const cfgBefore = deserializeConfig(persisted.cfg);

    // The market moved while the keeper was down: a freshly built config would have another p0.
    m.chain.s.failOpenWith = undefined;
    m.chain.s.now = cfgBefore.commitEnd - 30; // still inside the commit window
    const sent: RoundConfig[] = [];
    const real = m.chain.ops.openRound;
    m.chain.ops.openRound = async (c) => {
      sent.push(c);
      return real(c);
    };
    const second = await mkLoopAgain(m.chain, m.store);
    await second.loop.tick();
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(cfgBefore);
    expect(second.loop.state().rounds.length).toBe(1);
    expect(second.loop.state().rounds[0]).toMatchObject({ stage: "open", id: "1" });
  });

  it("a planned round whose commit window passed without being opened is closed as open_failed, not re-planned forever", async () => {
    const m = await mkLoop();
    m.chain.s.failOpenWith = new KeeperError("SIMULATION", "rpc down");
    const first = await m.start();
    await first.tick();
    const cfg = deserializeConfig(m.store.load(31337, ARENA).rounds[0]!.cfg);
    m.chain.s.failOpenWith = new KeeperError("BAD_ROUND", "commitEnd must be in the future");
    m.chain.s.now = cfg.commitEnd + 1;
    const second = await mkLoopAgain(m.chain, m.store);
    await second.loop.tick();
    expect(second.loop.state().rounds[0]).toMatchObject({ stage: "done", outcome: "open_failed" });
    expect(second.loop.state().rounds.length).toBe(1); // maxRounds: 1
  });

  it("refuses to start when the key is not the Arena keeper (the loop never begins)", async () => {
    const m = await mkLoop();
    m.chain.ops.verifyKeeper = async () => {
      throw new KeeperError("NOT_KEEPER", "the configured key is not the Arena keeper");
    };
    await expect(m.start()).rejects.toThrow(/not the Arena keeper/);
    expect(m.chain.s.calls).not.toContain("openRound");
  });

});

describe("anvil clock and licence-safe logs", () => {
  it("mineOnTick mines before reading the chain time, and only on the local chain", async () => {
    const { chain, start } = await mkLoop();
    const loop = await start({ mineOnTick: true });
    await loop.tick();
    expect(chain.s.calls[1]).toBe("mine");
    await expect(start({ mineOnTick: true, chainId: 84532 })).rejects.toThrow(/local anvil/);
  });

  it("no log line or alert contains a price", async () => {
    const { chain, feedState, logs, alerts, start } = await mkLoop();
    const loop = await start({ maxRounds: 1 });
    await loop.tick();
    const r = chain.s.rounds.get(1n) as RoundOnChain;
    feedState.windowStart = r.marketEnd;
    chain.s.now = r.revealEnd;
    await loop.tick();
    chain.s.now = r.marketEnd + 900 + 20;
    await loop.tick();
    const all = [...logs, ...alerts].join("\n");
    expect(all.length).toBeGreaterThan(50);
    for (const needle of ["123.4567", "123.5802", "123.7654", "123.6419", "123456700"]) expect(all).not.toContain(needle);
  });
});

describe("file state store", () => {
  const mkdir = () => mkdtempSync(join(tmpdir(), "keeper-state-test-"));
  const cfg: RoundConfig = {
    ticker: "AAPL",
    p0: 123_456_700n,
    T: 15,
    commitEnd: T0 + 90,
    revealEnd: T0 + 120,
    marketEnd: T0 + 180,
    candleSec: 300,
    settleDeadline: T0 + 5000,
    entryStake: 10n,
  };

  it("round-trips a state with bigint values and starts empty when there is no file", () => {
    const dir = mkdir();
    try {
      const store = new FileStateStore(join(dir, "sub", "state.json"));
      expect(store.load(31337, ARENA).rounds).toEqual([]);
      const st = store.load(31337, ARENA);
      st.rounds.push({ seq: 1, cfg: serializeConfig(cfg), fromBlock: "7", stage: "planned" });
      store.save(st);
      const back = store.load(31337, ARENA.toUpperCase().replace("0X", "0x"));
      expect(deserializeConfig(back.rounds[0]!.cfg)).toEqual(cfg);
      expect(readdirSync(join(dir, "sub"))).toEqual(["state.json"]); // no temp file left behind
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file written for another chain or arena, and a corrupt file, without touching them", () => {
    const dir = mkdir();
    try {
      const file = join(dir, "state.json");
      const store = new FileStateStore(file);
      store.save(store.load(31337, ARENA));
      expect(() => store.load(84532, ARENA)).toThrow(/belongs to chain 31337/);
      expect(() => store.load(31337, "0x4Da1FBb0f99D27F566Aa08243A4D6B8276E69AB7")).toThrow(/arena/);
      for (const bad of ["not json", '{"version":2}', '{"version":1,"chainId":31337,"arena":"x","rounds":[{"seq":1}]}']) {
        writeFileSync(file, bad);
        expect(() => store.load(31337, ARENA)).toThrow(/corrupt/);
        expect(readFileSync(file, "utf8")).toBe(bad);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the file never contains a private key and keeps owner-only permissions on POSIX", () => {
    const dir = mkdir();
    try {
      const file = join(dir, "state.json");
      const store = new FileStateStore(file);
      const st = store.load(31337, ARENA);
      st.rounds.push({ seq: 1, cfg: serializeConfig(cfg), fromBlock: "7", stage: "open", id: "3" });
      store.save(st);
      expect(readFileSync(file, "utf8")).not.toMatch(/0x[0-9a-fA-F]{64}/);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
