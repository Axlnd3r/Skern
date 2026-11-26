// GET /context/:id: the round context for house agents, served from the keeper state (history stored when the
// round was planned). No provider call and no chain read at request time; bp only, never a price.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoundContext } from "../../agents/src/house/types";
import type { Candle } from "../../shared/score";
import type { Bar } from "../src/candles";
import { roundContextFromState } from "../src/context";
import { demoTemplate, startDemo } from "../src/demo";
import type { KeeperDeps } from "../src/rounds";
import { startLoop, type LoopHandle } from "../src/loop";
import type { LoopOps } from "../src/ops";
import { createRelay, type Relay, type RelayChain, type RelayOptions } from "../src/relay";
import type { RoundConfig } from "../src/rounds";
import { MAX_HISTORY_CANDLES, historyCandles, planRoundWithHistory, type PriceFeed, type RoundTemplate } from "../src/source";
import { FileStateStore, MemoryStateStore, StateError, emptyState, type KeeperState } from "../src/state";

const T0 = 1_800_000_000; // divisible by 60 and 300
const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Price of the minute starting at `t`: a deterministic wiggle around 123.4, 2 decimals. */
const priceAt = (t: number): number => Math.round((123.4 + ((t / 60) % 13) * 0.01) * 100) / 100;

/** Records every bar array the loop received from the feed (so the test can recompute the expected history). */
function recordingFeed() {
  const served: Bar[][] = [];
  let calls = 0;
  const feed: PriceFeed = {
    mode: "live",
    attributionBase: "https://twelvedata.com/",
    attributionParams: { interval: "1min" },
    async bars(_ticker, from, to) {
      calls++;
      const out: Bar[] = [];
      for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) {
        const p = priceAt(t);
        out.push({ t, open: p, high: Math.round((p + 0.03) * 100) / 100, low: Math.round((p - 0.02) * 100) / 100, close: p });
      }
      served.push(out);
      return out;
    },
  };
  return { feed, served, calls: () => calls };
}

/** Minimal fake chain for the loop. */
function fakeOps(opts: { failOpen?: boolean } = {}) {
  const s = { now: T0, rounds: new Map<bigint, RoundConfig>() };
  const ops: LoopOps = {
    async verifyKeeper() {},
    async chainNow() {
      return s.now;
    },
    async blockNumber() {
      return 100n;
    },
    async openRound(cfg) {
      if (opts.failOpen) throw new Error("rpc down");
      const id = BigInt(s.rounds.size + 1);
      s.rounds.set(id, cfg);
      return id;
    },
    async recoverRoundId() {
      return undefined;
    },
    async getRound(id) {
      const r = s.rounds.get(id);
      if (!r) throw new Error("unknown round");
      return r;
    },
    async settled() {
      return false;
    },
    async isVoid() {
      return false;
    },
    async isFrozen() {
      return false;
    },
    async freezeAll() {},
    async postCandles() {},
  };
  return { s, ops };
}

/** A relay chain that must never be touched by the context route. */
function untouchableChain() {
  const touched: string[] = [];
  const boom = (name: string) => async (): Promise<never> => {
    touched.push(name);
    throw new Error(`chain.${name} must not be called`);
  };
  const chain: RelayChain = {
    chainNow: boom("chainNow"),
    roundCount: boom("roundCount"),
    getRound: boom("getRound"),
    entryOf: boom("entryOf"),
    sendReveal: boom("sendReveal"),
    waitReveal: boom("waitReveal"),
  };
  return { chain, touched };
}

const handles: LoopHandle[] = [];
const relays: Relay[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const r of relays.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(over: { store?: MemoryStateStore | FileStateStore; failOpen?: boolean; relay?: Partial<RelayOptions> } = {}) {
  const f = recordingFeed();
  const c = fakeOps({ failOpen: over.failOpen });
  const store = over.store ?? new MemoryStateStore();
  const start = async (): Promise<LoopHandle> => {
    const h = await startLoop({
      ops: c.ops,
      chainId: 31337,
      arena: ARENA,
      feed: f.feed,
      store,
      template: demoTemplate({ leadSec: 0 }),
      tickMs: 0,
      log: () => {},
      alert: () => {},
    });
    handles.push(h);
    return h;
  };
  let loop = await start();
  const u = untouchableChain();
  const mkRelay = (l: () => LoopHandle): Relay => {
    const r = createRelay({
      chain: u.chain,
      flushMs: 0,
      log: () => {},
      nowMs: () => 1_000_000,
      contextOf: (id) => roundContextFromState(l().state(), id),
      ...over.relay,
    });
    relays.push(r);
    return r;
  };
  const relay = mkRelay(() => loop);
  const get = (path: string, ip = "10.0.0.1") => relay.handle({ method: "GET", path, ip, body: "" });
  return { f, c, store, relay, get, touched: u.touched, loop: () => loop, restart: async () => (loop = await start()), mkRelay };
}

/** Expected history, computed from the bars the loop received with integer micro-unit arithmetic. */
function expectedHistory(bars: Bar[], from: number, now: number, candleSec: number): Candle[] {
  const micro = (p: number): number => Math.round(p * 1_000_000);
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const p0m = micro((sorted[sorted.length - 1] as Bar).close);
  const bp = (p: number): number => Math.round(((micro(p) - p0m) * 10000) / p0m);
  const starts = new Set<number>();
  for (const b of sorted) starts.add(Math.floor(b.t / candleSec) * candleSec);
  const out: Candle[] = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (s < from || s + candleSec > now) continue;
    const inB = sorted.filter((b) => b.t >= s && b.t < s + candleSec);
    if (inB.length !== candleSec / 60) continue;
    out.push({
      close: bp((inB[inB.length - 1] as Bar).close),
      high: bp(Math.max(...inB.map((b) => b.high))),
      low: bp(Math.min(...inB.map((b) => b.low))),
    });
  }
  return out;
}

describe("historyCandles (hand-computed)", () => {
  it("closes, highs and lows of complete intervals in bp relative to p0; a partial interval is ignored", () => {
    const bar = (t: number, high: number, low: number, close: number): Bar => ({ t, open: close, high, low, close });
    const bars = [
      bar(240, 101, 99, 100.5), // interval 240..360: close 101, high 102, low 99
      bar(300, 102, 100, 101),
      bar(360, 101, 100, 100.5), // interval 360..480: close 99.8, high 101, low 99.5
      bar(420, 100.8, 99.5, 99.8),
      bar(480, 100.2, 99.9, 100), // interval 480..600: close 100.1, high 100.3, low 99.9
      bar(540, 100.3, 100, 100.1),
      bar(600, 150, 50, 100), // starts the partial interval 600..720 at now = 600+60: ignored
    ];
    expect(historyCandles(bars, 120, 240, 660, 100_000_000n)).toEqual([
      { close: 100, high: 200, low: -100 },
      { close: -20, high: 100, low: -50 },
      { close: 10, high: 30, low: -10 },
    ]);
  });

  it("an off-grid bar cannot fill the slot of a missing on-grid minute", () => {
    const bar = (t: number, close: number): Bar => ({ t, open: close, high: close, low: close, close });
    // interval 240..360 needs the minutes t=240 and t=300; t=310 is off the minute grid and must not count
    const offGrid = [bar(240, 100), bar(310, 101)];
    expect(historyCandles(offGrid, 120, 240, 360, 100_000_000n)).toEqual([]);
    // the same interval with the real t=300 bar is complete
    const onGrid = [bar(240, 100), bar(300, 101)];
    expect(historyCandles(onGrid, 120, 240, 360, 100_000_000n)).toEqual([{ close: 100, high: 100, low: 0 }]);
  });

  it("keeps only the newest MAX_HISTORY_CANDLES intervals", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < MAX_HISTORY_CANDLES + 10; i++) bars.push({ t: i * 60, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i });
    const h = historyCandles(bars, 60, 0, (MAX_HISTORY_CANDLES + 10) * 60, 100_000_000n);
    expect(h.length).toBe(MAX_HISTORY_CANDLES);
    expect(h[h.length - 1]?.close).toBe(Math.round(((100 + MAX_HISTORY_CANDLES + 9 - 100) / 100) * 10000));
  });
});

describe("planRoundWithHistory at an unaligned now (hand-computed)", () => {
  // candleSec 120, history 600 s, now = T0 + 30 (T0 is a multiple of 120), so the fetch starts at T0 - 570, in the
  // middle of the interval [T0-600, T0-480): that interval gets only its second bar and must NOT be a candle. The
  // interval [T0, T0+120) is still running. P0 = close of the newest bar (T0) = 100.0.
  const tpl: RoundTemplate = {
    ticker: "X", candleSec: 120, commitSec: 90, revealSec: 30, marketSec: 60, leadSec: 0, settleGraceSec: 3600,
    entryStake: 10n, historySec: 600, minCloses: 3,
  };
  // minute k (t = T0 + 60k): [close, high, low], open = close
  const minute: Record<number, [number, number, number]> = {
    [-9]: [90, 95, 85], // cut off at the start: its extremes (85..95) must not appear anywhere
    [-8]: [100.5, 101, 100],
    [-7]: [101, 102, 100.2],
    [-6]: [100, 100.4, 99.6],
    [-5]: [99, 100, 98.5],
    [-4]: [99.5, 99.8, 99.4],
    [-3]: [100.2, 100.3, 99.5],
    [-2]: [100.1, 100.1, 99.9],
    [-1]: [99.9, 100.2, 99.7],
    [0]: [100, 100, 100],
  };
  const feedWith = (drop: number[] = []): PriceFeed => ({
    mode: "live",
    attributionBase: "https://twelvedata.com/",
    attributionParams: {},
    async bars(_t, from, to) {
      const out: Bar[] = [];
      for (const [k, [c, h, l]] of Object.entries(minute)) {
        const t = T0 + 60 * Number(k);
        if (t >= from && t < to && !drop.includes(Number(k))) out.push({ t, open: c, high: h, low: l, close: c });
      }
      return out;
    },
  });

  it("emits exactly the four complete candles, none from the cut-off or running interval", async () => {
    const { config, historyBp } = await planRoundWithHistory(tpl, feedWith(), T0 + 30);
    expect(config.p0).toBe(100_000_000n);
    expect(historyBp).toEqual([
      { close: 100, high: 200, low: 0 }, // [T0-480, T0-360): bars -8,-7
      { close: -100, high: 40, low: -150 }, // [T0-360, T0-240): bars -6,-5
      { close: 20, high: 30, low: -60 }, // [T0-240, T0-120): bars -4,-3
      { close: -10, high: 20, low: -30 }, // [T0-120, T0): bars -2,-1
    ]);
  });

  it("an interval with a missing bar is left out, not built from fewer bars", async () => {
    const { historyBp } = await planRoundWithHistory(tpl, feedWith([-4]), T0 + 30);
    expect(historyBp).toEqual([
      { close: 100, high: 200, low: 0 },
      { close: -100, high: 40, low: -150 },
      { close: -10, high: 20, low: -30 },
    ]);
  });
});

describe("GET /context/:id served from a round the loop opened", () => {
  it("returns exactly the RoundContext shape; the history matches the bars the loop used", async () => {
    const t = await setup();
    await t.loop().tick();
    expect(t.f.calls()).toBe(1); // the loop's one planning call
    const r = await t.get("/context/1");
    expect(r.status).toBe(200);
    const body = r.json as RoundContext;
    expect(Object.keys(body)).toEqual(["ticker", "T", "candleCount", "recentCandlesBp"]);
    expect(body.ticker).toBe("AAPL");
    expect(body.candleCount).toBe(3);
    expect(body.T).toBe(t.loop().state().rounds[0]?.cfg.T);
    const expected = expectedHistory(t.f.served[0] as Bar[], T0 - 24 * 300, T0, 300);
    expect(expected.length).toBe(24);
    expect(body.recentCandlesBp).toEqual(expected);
    // every candle is int32 bp with low <= close <= high, field order close/high/low
    for (const c of body.recentCandlesBp) {
      expect(Object.keys(c)).toEqual(["close", "high", "low"]);
      expect(Number.isInteger(c.close) && Number.isInteger(c.high) && Number.isInteger(c.low)).toBe(true);
      expect(c.low).toBeLessThanOrEqual(c.close);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
    }
    // serving the context made no provider call and no chain read
    expect(t.f.calls()).toBe(1);
    expect(t.touched).toEqual([]);
  });

  it("at an unaligned chain time the cut-off first interval is dropped (23 complete candles, not 24)", async () => {
    const t = await setup();
    t.c.s.now = T0 + 150;
    await t.loop().tick();
    const body = (await t.get("/context/1")).json as RoundContext;
    const from = T0 + 150 - 24 * 300;
    expect(body.recentCandlesBp.length).toBe(23);
    expect(body.recentCandlesBp).toEqual(expectedHistory(t.f.served[0] as Bar[], from, T0 + 150, 300));
  });

  it("contains no raw price (no p0, no provider price, no decimals)", async () => {
    const t = await setup();
    await t.loop().tick();
    const r = await t.get("/context/1");
    const text = JSON.stringify(r.json);
    const p0 = t.loop().state().rounds[0]?.cfg.p0 as string; // micro-units, for example 123400000
    expect(text).not.toContain(p0);
    expect(text).not.toMatch(/123\.\d/);
    expect(text).not.toMatch(/12340\d/);
    expect(text).not.toMatch(/\d\.\d/); // integers only
    expect(text).not.toMatch(/p0|price|open/i);
  });

  it("unknown id is 404, a not-yet-open round (planned, no id) is 404, id 0 / garbage are 400", async () => {
    const t = await setup();
    await t.loop().tick();
    const unknown = await t.get("/context/2");
    expect(unknown).toMatchObject({ status: 404, body: { ok: false, code: "UNKNOWN_ROUND" } });
    expect(unknown.json).toBeUndefined();
    for (const bad of ["/context/0", "/context/abc", "/context/-1", "/context/01", "/context/1.5", "/context/", "/context/1/2", "/context/" + "9".repeat(20), "/context/0x1"]) {
      expect(await t.get(bad), bad).toMatchObject({ status: 400, body: { ok: false, code: "BAD_REQUEST" } });
    }
    const planned = await setup({ failOpen: true });
    await planned.loop().tick();
    expect(planned.loop().state().rounds[0]?.stage).toBe("planned");
    expect(await planned.get("/context/1")).toMatchObject({ status: 404, body: { code: "UNKNOWN_ROUND" } });
  });

  it("a round without stored history (older state file) gets a valid context with an empty history", async () => {
    const t = await setup();
    await t.loop().tick();
    delete t.loop().state().rounds[0]?.historyBp;
    const r = await t.get("/context/1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ticker: "AAPL", candleCount: 3, recentCandlesBp: [] });
  });

  it("a round the keeper marked id_mismatch is not served", async () => {
    const t = await setup();
    await t.loop().tick();
    const rec = t.loop().state().rounds[0];
    if (rec) rec.outcome = "id_mismatch";
    expect(await t.get("/context/1")).toMatchObject({ status: 404 });
  });

  it("the response is a copy: changing it does not change the keeper state", async () => {
    const t = await setup();
    await t.loop().tick();
    const first = { ...((t.loop().state().rounds[0]?.historyBp ?? [])[0] as Candle) };
    const r = (await t.get("/context/1")).json as RoundContext;
    (r.recentCandlesBp[0] as { close: number }).close = 12345;
    r.recentCandlesBp = [];
    expect((t.loop().state().rounds[0]?.historyBp ?? [])[0]).toEqual(first);
    expect(((await t.get("/context/1")).json as RoundContext).recentCandlesBp[0]).toEqual(first);
  });

  it("only GET is allowed", async () => {
    const t = await setup();
    await t.loop().tick();
    const r = await t.relay.handle({ method: "POST", path: "/context/1", ip: "10.0.0.1", contentType: "application/json", body: "{}" });
    expect(r).toMatchObject({ status: 405, body: { code: "METHOD_NOT_ALLOWED" } });
  });

  it("has its own per-IP rate limit that does not use up the reveal budget", async () => {
    const t = await setup({ relay: { contextBurst: 2, contextPerMin: 1, ratePerMin: 1, burst: 1 } });
    await t.loop().tick();
    expect((await t.get("/context/1")).status).toBe(200);
    expect((await t.get("/context/1")).status).toBe(200);
    expect(await t.get("/context/1")).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect((await t.get("/context/1", "10.0.0.2")).status).toBe(200); // another client is unaffected
    // the same IP can still send a reveal (rejected for its body, not for the rate)
    const rv = await t.relay.handle({ method: "POST", path: "/reveal", ip: "10.0.0.1", contentType: "application/json", body: "{}" });
    expect(rv.status).toBe(400);
  });

  it("without a contextOf the route does not exist", async () => {
    const r = createRelay({ chain: untouchableChain().chain, flushMs: 0, log: () => {} });
    expect(await r.handle({ method: "GET", path: "/context/1", ip: "x", body: "" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });

  it("a failing contextOf is a 500 INTERNAL, not a crash", async () => {
    const r = createRelay({
      chain: untouchableChain().chain,
      flushMs: 0,
      log: () => {},
      contextOf: () => {
        throw new Error("boom");
      },
    });
    expect(await r.handle({ method: "GET", path: "/context/1", ip: "x", body: "" })).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
  });
});

describe("restart safety", () => {
  it("the history survives a restart through the in-memory store and through the state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    dirs.push(dir);
    const file = join(dir, "keeper-state.json");
    const t = await setup({ store: new FileStateStore(file) });
    await t.loop().tick();
    const before = (await t.get("/context/1")).json as RoundContext;
    expect(before.recentCandlesBp.length).toBe(24);
    await t.loop().stop();
    // the file holds bp only: no p0-scale price besides the config's own p0
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text).rounds[0].historyBp.length).toBe(24);
    // a brand new loop (and relay) on the same file serves the same context without any feed call
    const callsBefore = t.f.calls();
    const loop2 = await t.restart();
    const relay2 = t.mkRelay(() => loop2);
    const after = await relay2.handle({ method: "GET", path: "/context/1", ip: "10.0.0.9", body: "" });
    expect(after.json).toEqual(before);
    expect(t.f.calls()).toBe(callsBefore);
  });

  it("an old state file WITHOUT historyBp loads and serves a 200 with an empty history", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "keeper-state.json");
    const old = {
      version: 1,
      chainId: 31337,
      arena: ARENA.toLowerCase(),
      rounds: [
        {
          seq: 1,
          cfg: { ticker: "AAPL", p0: "123400000", T: 15, commitEnd: 1, revealEnd: 2, marketEnd: 3, candleSec: 300, settleDeadline: 4, entryStake: "10" },
          fromBlock: "1",
          id: "1",
          stage: "open",
        },
      ],
    };
    writeFileSync(file, JSON.stringify(old, null, 2));
    const state = new FileStateStore(file).load(31337, ARENA);
    expect(state.rounds[0]?.historyBp).toBeUndefined();
    const relay = createRelay({ chain: untouchableChain().chain, flushMs: 0, log: () => {}, contextOf: (id) => roundContextFromState(state, id) });
    return relay.handle({ method: "GET", path: "/context/1", ip: "x", body: "" }).then((r) => {
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ticker: "AAPL", T: 15, candleCount: 3, recentCandlesBp: [] });
    });
  });

  it("the state file rejects a damaged history instead of trusting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    dirs.push(dir);
    const file = join(dir, "keeper-state.json");
    const store = new FileStateStore(file);
    const state: KeeperState = emptyState(31337, ARENA);
    state.rounds.push({
      seq: 1,
      cfg: { ticker: "AAPL", p0: "123400000", T: 15, commitEnd: 1, revealEnd: 2, marketEnd: 3, candleSec: 300, settleDeadline: 4, entryStake: "10" },
      fromBlock: "1",
      id: "1",
      stage: "open",
      historyBp: [{ close: 1, high: 2, low: 0 }],
    });
    store.save(state);
    expect(store.load(31337, ARENA).rounds[0]?.historyBp).toEqual([{ close: 1, high: 2, low: 0 }]);
    for (const bad of [[{ close: 1.5, high: 2, low: 0 }], [{ close: 1, high: 2 }], ["x"], "nope", [{ close: 2 ** 31, high: 2, low: 0 }]]) {
      (state.rounds[0] as { historyBp: unknown }).historyBp = bad;
      store.save(state);
      expect(() => store.load(31337, ARENA)).toThrow(StateError);
    }
  });
});

describe("over real HTTP", () => {
  it("serves the bare RoundContext JSON with CORS, 404 and 400 in the relay error shape", async () => {
    const t = await setup({ relay: { allowOrigins: ["https://app.example"] } });
    await t.loop().tick();
    const { port } = await t.relay.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const ok = await fetch(`${base}/context/1`, { headers: { origin: "https://app.example" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("content-type")).toBe("application/json");
    const json = (await ok.json()) as RoundContext;
    expect(Object.keys(json)).toEqual(["ticker", "T", "candleCount", "recentCandlesBp"]);
    expect(json.recentCandlesBp.length).toBe(24);

    const other = await fetch(`${base}/context/1`, { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();

    const nf = await fetch(`${base}/context/99`);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ ok: false, code: "UNKNOWN_ROUND", message: "no such round" });
    const bad = await fetch(`${base}/context/x`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("BAD_REQUEST");

    const pre = await fetch(`${base}/context/1`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});

describe("demo wiring", () => {
  it("startDemo serves /context/1 once its loop has opened a round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-demo-"));
    dirs.push(dir);
    const f = recordingFeed();
    const c = fakeOps();
    const deps = { chainId: 31337, arenaAddress: ARENA } as unknown as KeeperDeps; // the context route never uses it
    const h = await startDemo({
      env: { RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", KEEPER_STATE_DIR: dir },
      deps,
      ops: c.ops,
      feed: f.feed,
      log: () => {},
    });
    try {
      const base = `http://127.0.0.1:${h.relayPort}`;
      expect((await fetch(`${base}/context/1`)).status).toBe(404); // no round yet
      await h.loop.tick();
      const r = await fetch(`${base}/context/1`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as RoundContext;
      expect(body).toMatchObject({ ticker: "AAPL", candleCount: 3 });
      expect(body.recentCandlesBp.length).toBe(24);
    } finally {
      await h.stop();
    }
  });
});
