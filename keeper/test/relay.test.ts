// Reveal relay: every rejection, the success path, the queue, rate limits and the HTTP layer.
// A fake chain stands in for the Arena; `sent` records every reveal the relay would have paid gas for.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { hashPath } from "../../agents/src/salt";
import type { Path } from "../../shared/score";
import {
  FileQueueStore,
  MemoryQueueStore,
  RelayChainError,
  createRelay,
  parseRevealRequest,
  type EntryView,
  type Relay,
  type RelayChain,
  type RelayOptions,
  type RelayRequest,
} from "../src/relay";

const WHO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const SALT = ("0x" + "11".repeat(32)) as Hex;
const OTHER_SALT = ("0x" + "22".repeat(32)) as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hex;
const PATH: Path = [
  { close: 10, high: 12, low: 0 },
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];
const BAD_PATH: Path = [
  { close: 10, high: 5, low: 0 }, // high below close
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];
const COMMIT_END = 1000;
const REVEAL_END = 1030;

function fakeChain() {
  const s = {
    now: COMMIT_END + 5,
    count: 3n,
    entries: new Map<string, EntryView>(),
    sent: [] as { id: bigint; who: Address; path: Path; salt: Hex }[],
    reads: 0,
    sendError: undefined as Error | undefined,
    sendGate: undefined as Promise<void> | undefined,
    wait: "success" as "success" | "reverted" | "timeout",
    rpcDown: false,
    roundError: false,
    sendDelayMs: 0,
    active: 0,
    maxActive: 0,
    revealedAfterRevert: false,
  };
  const key = (id: bigint, who: Address) => `${id}:${who.toLowerCase()}`;
  const chain: RelayChain = {
    async chainNow() {
      s.reads++;
      if (s.rpcDown) throw new Error("http://rpc.example/v2/SECRET-API-KEY down");
      return s.now;
    },
    async roundCount() {
      s.reads++;
      return s.count;
    },
    async getRound() {
      s.reads++;
      if (s.roundError) throw new Error("429 Too Many Requests");
      return { commitEnd: COMMIT_END, revealEnd: REVEAL_END };
    },
    async entryOf(id, who) {
      s.reads++;
      return s.entries.get(key(id, who)) ?? { kind: 0, revealed: false, hash: ("0x" + "00".repeat(32)) as Hex };
    },
    async sendReveal(id, who, path, salt) {
      s.active++;
      s.maxActive = Math.max(s.maxActive, s.active);
      try {
        if (s.sendGate) await s.sendGate;
        if (s.sendDelayMs > 0) await new Promise((r) => setTimeout(r, s.sendDelayMs));
        s.sent.push({ id, who, path, salt });
        if (s.sendError) throw s.sendError;
        return TX;
      } finally {
        s.active--;
      }
    },
    async waitReveal() {
      if (s.wait === "reverted" && s.revealedAfterRevert) {
        for (const [k, v] of s.entries) s.entries.set(k, { ...v, revealed: true });
      }
      return s.wait;
    },
  };
  const commit = (id: bigint, who: Address, path: Path, salt: Hex, extra: Partial<EntryView> = {}) =>
    s.entries.set(key(id, who), { kind: 1, revealed: false, hash: hashPath(path, salt, who), ...extra });
  return { s, chain, commit };
}

const body = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: "1", who: WHO, path: PATH, salt: SALT, ...o });
const req = (b: string, over: Partial<RelayRequest> = {}): RelayRequest => ({
  method: "POST",
  path: "/reveal",
  ip: "10.0.0.1",
  contentType: "application/json",
  body: b,
  ...over,
});

function mk(opts: Partial<RelayOptions> = {}) {
  const f = fakeChain();
  f.commit(1n, WHO, PATH, SALT);
  const logs: string[] = [];
  let ms = 1_000_000;
  const clock = { advance: (n: number) => (ms += n) };
  const relay = createRelay({ chain: f.chain, flushMs: 0, log: (m) => logs.push(m), nowMs: () => ms, ratePerMin: 1000, burst: 1000, globalPerMin: 100000, ...opts });
  return { ...f, relay, logs, clock };
}

describe("relay request validation", () => {
  it("accepts a well-formed request and returns the typed fields", () => {
    const p = parseRevealRequest(body({ id: 7 }));
    expect("reject" in p).toBe(false);
    expect(p).toMatchObject({ id: 7n, who: WHO, salt: SALT });
  });

  it.each([
    ["not JSON", "{oops", 400, "BAD_JSON"],
    ["truncated", '{"id":', 400, "BAD_JSON"],
    ["an array", "[]", 400, "BAD_REQUEST"],
    ["null", "null", 400, "BAD_REQUEST"],
    ["id 0", body({ id: "0" }), 400, "BAD_REQUEST"],
    ["negative id", body({ id: -1 }), 400, "BAD_REQUEST"],
    ["fractional id", body({ id: 1.5 }), 400, "BAD_REQUEST"],
    ["huge id", body({ id: "99999999999999999999999" }), 400, "BAD_REQUEST"],
    ["id with text", body({ id: "1; drop" }), 400, "BAD_REQUEST"],
    ["who not an address", body({ who: "0x1234" }), 400, "BAD_REQUEST"],
    ["who missing", JSON.stringify({ id: "1", path: PATH, salt: SALT }), 400, "BAD_REQUEST"],
    ["short salt", body({ salt: "0x1234" }), 400, "BAD_REQUEST"],
    ["salt without 0x", body({ salt: "11".repeat(32) }), 400, "BAD_REQUEST"],
    ["two candles", body({ path: PATH.slice(0, 2) }), 400, "BAD_REQUEST"],
    ["four candles", body({ path: [...PATH, PATH[0]] }), 400, "BAD_REQUEST"],
    ["fractional close", body({ path: [{ close: 1.5, high: 2, low: 0 }, PATH[1], PATH[2]] }), 400, "BAD_REQUEST"],
    ["string close", body({ path: [{ close: "1", high: 2, low: 0 }, PATH[1], PATH[2]] }), 400, "BAD_REQUEST"],
    ["close beyond int32", body({ path: [{ close: 2147483648, high: 2147483648, low: 0 }, PATH[1], PATH[2]] }), 400, "BAD_REQUEST"],
    ["a null candle", body({ path: [null, PATH[1], PATH[2]] }), 400, "BAD_REQUEST"],
  ])("rejects %s", async (_n, b, status, code) => {
    const m = mk();
    const r = await m.relay.handle(req(b));
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    expect(r.body.ok).toBe(false);
    expect(m.s.sent.length).toBe(0);
    expect(m.s.reads).toBe(0); // nothing is read from the chain for a malformed request
  });

  it("rejects an invalid path (high below close) without touching the chain", async () => {
    const m = mk();
    const r = await m.relay.handle(req(body({ path: BAD_PATH })));
    expect(r).toMatchObject({ status: 422, body: { code: "INVALID_PATH" } });
    expect(m.s.sent.length).toBe(0);
    expect(m.s.reads).toBe(0);
  });

  it("rejects a body over the size limit (413) before parsing it or reading the chain", async () => {
    const m = mk({ maxBodyBytes: 200 });
    const r = await m.relay.handle(req(body({ pad: "x".repeat(500) })));
    expect(r).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
    expect(m.s.reads).toBe(0);
    // the default limit is small too
    const big = await mk().relay.handle(req(JSON.stringify({ x: "y".repeat(10_000) })));
    expect(big.status).toBe(413);
  });

  it("rejects a wrong content type, method and path", async () => {
    const m = mk();
    expect((await m.relay.handle(req(body(), { contentType: "text/plain" }))).status).toBe(415);
    expect((await m.relay.handle(req(body(), { contentType: undefined }))).status).toBe(415);
    expect((await m.relay.handle(req(body(), { method: "GET" }))).status).toBe(405);
    expect((await m.relay.handle(req(body(), { path: "/other" }))).status).toBe(404);
    expect(m.s.sent.length).toBe(0);
  });
});

describe("relay chain checks", () => {
  it("unknown round id -> 404", async () => {
    const m = mk();
    const r = await m.relay.handle(req(body({ id: "4" })));
    expect(r).toMatchObject({ status: 404, body: { code: "UNKNOWN_ROUND" } });
    expect(m.s.sent.length).toBe(0);
  });

  it("reveal window over (now >= revealEnd) -> 409, also at the exact boundary", async () => {
    const m = mk();
    m.s.now = REVEAL_END;
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 409, body: { code: "WRONG_WINDOW" } });
    m.s.now = REVEAL_END + 100;
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 409, body: { code: "WRONG_WINDOW" } });
    expect(m.s.sent.length).toBe(0);
  });

  it("the last second of the window still sends (now = revealEnd - 1)", async () => {
    const m = mk();
    m.s.now = REVEAL_END - 1;
    expect((await m.relay.handle(req(body()))).status).toBe(200);
    expect(m.s.sent.length).toBe(1);
  });

  it("an address without a commit -> 409 NO_COMMIT", async () => {
    const m = mk();
    const r = await m.relay.handle(req(body({ who: OTHER })));
    expect(r).toMatchObject({ status: 409, body: { code: "NO_COMMIT" } });
    expect(m.s.sent.length).toBe(0);
  });

  it("an agent commit (kind 2) is refused with a clear terminal error: no gas is paid, nothing is queued", async () => {
    const m = mk({ queueStore: new MemoryQueueStore() });
    m.commit(1n, OTHER, PATH, OTHER_SALT, { kind: 2 });
    const agentBody = body({ who: OTHER, salt: OTHER_SALT });
    expect(await m.relay.handle(req(agentBody))).toMatchObject({ status: 403, body: { ok: false, code: "AGENT_NOT_RELAYED" } });
    m.s.now = COMMIT_END - 10; // also during the commit window
    expect(await m.relay.handle(req(agentBody))).toMatchObject({ status: 403, body: { code: "AGENT_NOT_RELAYED" } });
    expect(m.s.sent.length).toBe(0);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("wrong salt, and a path that was committed for a different address -> 422 HASH_MISMATCH", async () => {
    const m = mk();
    expect(await m.relay.handle(req(body({ salt: OTHER_SALT })))).toMatchObject({ status: 422, body: { code: "HASH_MISMATCH" } });
    // OTHER committed with their own salt; WHO's request cannot reveal for OTHER and vice versa
    m.commit(1n, OTHER, PATH, SALT);
    expect(await m.relay.handle(req(body({ who: OTHER, salt: OTHER_SALT })))).toMatchObject({ status: 422, body: { code: "HASH_MISMATCH" } });
    const tampered = PATH.map((c) => ({ ...c })) as unknown as Path;
    (tampered[0] as { close: number }).close = 11;
    expect(await m.relay.handle(req(body({ path: tampered })))).toMatchObject({ status: 422, body: { code: "HASH_MISMATCH" } });
    expect(m.s.sent.length).toBe(0);
  });

  it("already revealed -> 200 success without sending (a front-run or an earlier request)", async () => {
    const m = mk();
    m.commit(1n, WHO, PATH, SALT, { revealed: true });
    const r = await m.relay.handle(req(body()));
    expect(r).toMatchObject({ status: 200, body: { ok: true, code: "ALREADY_REVEALED" } });
    expect(m.s.sent.length).toBe(0);
  });

  it("the chain being unreachable -> 503 and nothing is sent; the RPC URL does not leak", async () => {
    const m = mk();
    m.s.rpcDown = true;
    const r = await m.relay.handle(req(body()));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r) + m.logs.join("\n")).not.toContain("SECRET-API-KEY");
    expect(m.s.sent.length).toBe(0);
  });
});

describe("relay send path", () => {
  it("sends exactly one reveal with the request's id, who, path and salt and returns the tx", async () => {
    const m = mk();
    const r = await m.relay.handle(req(body()));
    expect(r).toMatchObject({ status: 200, body: { ok: true, code: "REVEALED", tx: TX } });
    expect(m.s.sent).toEqual([{ id: 1n, who: WHO, path: PATH, salt: SALT }]);
  });

  it("treats AlreadyRevealed from the dry run as success: one send attempt, no retry", async () => {
    const m = mk();
    m.s.sendError = new RelayChainError("AlreadyRevealed", "AlreadyRevealed");
    const r = await m.relay.handle(req(body()));
    expect(r).toMatchObject({ status: 200, body: { ok: true, code: "ALREADY_REVEALED" } });
    expect(m.s.sent.length).toBe(1);
    expect(m.logs.join("\n")).not.toMatch(/fail|alert|error/i);
  });

  it("a reveal that reverted because someone front-ran it is success (state re-read), no retry", async () => {
    const m = mk();
    m.s.wait = "reverted";
    m.s.revealedAfterRevert = true;
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 200, body: { code: "ALREADY_REVEALED" } });
    expect(m.s.sent.length).toBe(1);
  });

  it("a reveal that reverted for another reason is 502 and is never sent again", async () => {
    const m = mk();
    m.s.wait = "reverted";
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 502, body: { code: "REVEAL_FAILED" } });
    expect(m.s.sent.length).toBe(1);
  });

  it("a send failure is 502 (or success if the reveal landed anyway) and does not leak the cause", async () => {
    const m = mk();
    m.s.sendError = new RelayChainError("SEND_FAILED", "http://rpc.example/v2/SECRET-API-KEY refused");
    const r = await m.relay.handle(req(body()));
    expect(r).toMatchObject({ status: 502, body: { code: "REVEAL_FAILED" } });
    expect(JSON.stringify(r) + m.logs.join("\n")).not.toContain("SECRET-API-KEY");
    expect(m.s.sent.length).toBe(1);
    // the node accepted the transaction although the call errored: the next request sees it revealed
    const m2 = mk();
    m2.s.sendError = new RelayChainError("SEND_FAILED", "timeout");
    const orig = m2.chain.sendReveal;
    m2.chain.sendReveal = async (...a) => {
      m2.commit(1n, WHO, PATH, SALT, { revealed: true });
      return orig(...a);
    };
    expect(await m2.relay.handle(req(body()))).toMatchObject({ status: 200, body: { code: "ALREADY_REVEALED" } });
  });

  it("a gas estimate above the bound is refused (502)", async () => {
    const m = mk();
    m.s.sendError = new RelayChainError("GAS_TOO_HIGH", "gas estimate 9000000");
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 502 });
  });

  it("a Window/NoCommit/HashMismatch revert from the dry run maps to 409/409/422, never retried", async () => {
    for (const [code, status] of [
      ["RevealWindowClosed", 409],
      ["NoCommit", 409],
      ["HashMismatch", 422],
      ["InvalidPath", 422],
    ] as const) {
      const m = mk();
      m.s.sendError = new RelayChainError(code, code);
      expect((await m.relay.handle(req(body()))).status).toBe(status);
      expect(m.s.sent.length).toBe(1);
    }
  });

  it("one in-flight reveal per (id, who): a concurrent duplicate gets 409 and sends nothing", async () => {
    const m = mk();
    let release!: () => void;
    m.s.sendGate = new Promise<void>((r) => (release = r));
    const first = m.relay.handle(req(body()));
    await new Promise((r) => setTimeout(r, 5));
    const dup = await m.relay.handle(req(body(), { ip: "10.0.0.2" }));
    expect(dup).toMatchObject({ status: 409, body: { code: "IN_FLIGHT" } });
    release();
    expect((await first).status).toBe(200);
    expect(m.s.sent.length).toBe(1);
  });

  it("a different address is not blocked by someone else's in-flight reveal", async () => {
    const m = mk();
    m.commit(1n, OTHER, PATH, OTHER_SALT);
    let release!: () => void;
    m.s.sendGate = new Promise<void>((r) => (release = r));
    const a = m.relay.handle(req(body()));
    const b = m.relay.handle(req(body({ who: OTHER, salt: OTHER_SALT })));
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect([(await a).status, (await b).status]).toEqual([200, 200]);
    expect(m.s.sent.length).toBe(2);
  });

  it("after a send without confirmation the relay answers 202 and does not send again until the ttl passes", async () => {
    const m = mk({ pendingTtlMs: 60_000 });
    m.s.wait = "timeout";
    const first = await m.relay.handle(req(body()));
    expect(first).toMatchObject({ status: 202, body: { code: "PENDING", tx: TX } });
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 202, body: { code: "PENDING" } });
    expect(m.s.sent.length).toBe(1);
    m.clock.advance(61_000);
    await m.relay.handle(req(body()));
    expect(m.s.sent.length).toBe(2); // the ttl is over: the dry run decides again
  });

  it("at most maxInFlight reveals are processed at once (503 BUSY above it)", async () => {
    const m = mk({ maxInFlight: 1 });
    m.commit(1n, OTHER, PATH, OTHER_SALT);
    let release!: () => void;
    m.s.sendGate = new Promise<void>((r) => (release = r));
    const a = m.relay.handle(req(body()));
    await new Promise((r) => setTimeout(r, 5));
    const b = await m.relay.handle(req(body({ who: OTHER, salt: OTHER_SALT })));
    expect(b).toMatchObject({ status: 503, body: { code: "BUSY" } });
    release();
    await a;
    expect(m.s.sent.length).toBe(1);
  });
});

describe("relay rate limit", () => {
  it("one client is limited to its burst, other clients are not, and tokens refill over time", async () => {
    const m = mk({ burst: 3, ratePerMin: 6 });
    const bad = body({ id: "0" }); // cheap request that still counts
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await m.relay.handle(req(bad))).status);
    expect(codes).toEqual([400, 400, 400, 429, 429]);
    expect((await m.relay.handle(req(bad, { ip: "10.0.0.9" }))).status).toBe(400);
    m.clock.advance(10_000); // 6 per minute = one token per 10 s
    expect((await m.relay.handle(req(bad))).status).toBe(400);
    expect((await m.relay.handle(req(bad))).status).toBe(429);
  });

  it("a global cap protects the wallet from many clients (valid requests count)", async () => {
    const m = mk({ globalPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await m.relay.handle(req(body(), { ip: `10.0.1.${i}` }))).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it("junk (bad JSON, bad fields, invalid path) from many clients does not use up the global budget", async () => {
    const m = mk({ globalPerMin: 3 });
    for (let i = 0; i < 20; i++) {
      const junk = [body({ id: "0" }), "not json", body({ path: BAD_PATH })][i % 3] as string;
      expect((await m.relay.handle(req(junk, { ip: `10.0.2.${i}` }))).status).not.toBe(429);
    }
    expect((await m.relay.handle(req(body(), { ip: "10.0.3.1" }))).status).toBe(200);
    expect((await m.relay.handle(req(body(), { ip: "10.0.3.2" }))).status).toBe(200);
    expect((await m.relay.handle(req(body(), { ip: "10.0.3.3" }))).status).toBe(200);
    expect((await m.relay.handle(req(body(), { ip: "10.0.3.4" }))).status).toBe(429);
  });

  it("/health is not rate limited and needs no chain access", async () => {
    const m = mk({ burst: 1, ratePerMin: 1 });
    for (let i = 0; i < 5; i++) expect((await m.relay.handle({ method: "GET", path: "/health", ip: "x", body: "" })).status).toBe(200);
    expect(m.s.reads).toBe(0);
  });
});

describe("relay queue (the app sends right after the commit)", () => {
  it("during the commit window a valid request is queued (202), not sent", async () => {
    const m = mk({ queueStore: new MemoryQueueStore() });
    m.s.now = COMMIT_END - 10;
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 202, body: { code: "QUEUED" } });
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 202, body: { code: "QUEUED" } });
    expect(m.relay.queueSize()).toBe(1);
    expect(m.s.sent.length).toBe(0);
  });

  it("only a request that matches an on-chain commit can be queued", async () => {
    const m = mk({ queueStore: new MemoryQueueStore() });
    m.s.now = COMMIT_END - 10;
    expect((await m.relay.handle(req(body({ salt: OTHER_SALT })))).status).toBe(422);
    expect((await m.relay.handle(req(body({ who: OTHER })))).status).toBe(409);
    expect((await m.relay.handle(req(body({ path: BAD_PATH })))).status).toBe(422);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("flush sends nothing before commitEnd, sends once from commitEnd, and empties the queue", async () => {
    const store = new MemoryQueueStore();
    const m = mk({ queueStore: store });
    m.s.now = COMMIT_END - 10;
    await m.relay.handle(req(body()));
    await m.relay.flush();
    expect(m.s.sent.length).toBe(0);
    m.s.now = COMMIT_END;
    await m.relay.flush();
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    expect(m.relay.queueSize()).toBe(0);
    expect(store.load()).toEqual([]);
  });

  it("flush drops an entry whose window is over and never sends it", async () => {
    const m = mk({ queueStore: new MemoryQueueStore() });
    m.s.now = COMMIT_END - 10;
    await m.relay.handle(req(body()));
    m.s.now = REVEAL_END;
    await m.relay.flush();
    expect(m.s.sent.length).toBe(0);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("the queue survives a restart: a new relay with the same store reveals from it", async () => {
    const store = new MemoryQueueStore();
    const m = mk({ queueStore: store });
    m.s.now = COMMIT_END - 10;
    await m.relay.handle(req(body()));
    const again = createRelay({ chain: m.chain, queueStore: store, flushMs: 0, log: () => {} });
    expect(again.queueSize()).toBe(1);
    m.s.now = COMMIT_END + 1;
    await again.flush();
    expect(m.s.sent.length).toBe(1);
  });

  async function queued(opts: Partial<RelayOptions> = {}) {
    const m = mk({ queueStore: new MemoryQueueStore(), ...opts });
    m.s.now = COMMIT_END - 10;
    await m.relay.handle(req(body()));
    expect(m.relay.queueSize()).toBe(1);
    m.s.now = COMMIT_END + 1;
    return m;
  }

  it("send failures never drop a queued entry while the window is open; one send lands once the error clears", async () => {
    const m = await queued();
    m.s.sendError = new RelayChainError("SEND_FAILED", "429 Too Many Requests");
    for (let i = 0; i < 10; i++) {
      await m.relay.flush();
      m.clock.advance(10_000); // longer than the backoff cap
    }
    expect(m.relay.queueSize()).toBe(1);
    expect(m.s.sent.length).toBe(10);
    m.s.sendError = undefined;
    const before = m.s.sent.length;
    await m.relay.flush();
    expect(m.s.sent.length - before).toBe(1);
    expect(m.relay.queueSize()).toBe(0);
    await m.relay.flush();
    expect(m.s.sent.length - before).toBe(1);
  });

  it("getRound errors never drop a queued entry while the window is open; one send lands once the error clears", async () => {
    const m = await queued();
    m.s.roundError = true;
    for (let i = 0; i < 10; i++) {
      await m.relay.flush();
      m.clock.advance(10_000);
    }
    expect(m.relay.queueSize()).toBe(1);
    expect(m.s.sent.length).toBe(0);
    m.s.roundError = false;
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("an unreachable chain (chainNow fails) keeps the entry", async () => {
    const m = await queued();
    m.s.rpcDown = true;
    for (let i = 0; i < 10; i++) await m.relay.flush();
    expect(m.relay.queueSize()).toBe(1);
    m.s.rpcDown = false;
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("retries back off: a second flush right after a failure does not send again, and a retry fits in a short window", async () => {
    const m = await queued();
    m.s.sendError = new RelayChainError("SEND_FAILED", "down");
    await m.relay.flush();
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    // the delay is capped at 2 s: a few tries fit in a 30 s window
    for (let i = 0; i < 12; i++) {
      m.clock.advance(2_000);
      await m.relay.flush();
    }
    expect(m.s.sent.length).toBeGreaterThanOrEqual(10);
  });

  it("a queued entry that kept failing is dropped, and never sent, once the window is over", async () => {
    const m = await queued();
    m.s.sendError = new RelayChainError("SEND_FAILED", "down");
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(1);
    m.clock.advance(10_000);
    m.s.now = REVEAL_END;
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(0);
    expect(m.s.sent.length).toBe(1);
  });

  it("a window that ended while getRound keeps failing is still dropped (revealEnd was seen before)", async () => {
    const m = await queued();
    m.s.roundError = true;
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(1);
    m.clock.advance(10_000);
    m.s.now = REVEAL_END + 5;
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(0);
    expect(m.s.sent.length).toBe(0);
  });

  it("terminal answers drop the entry at once: NoCommit, HashMismatch, InvalidPath, AlreadyRevealed", async () => {
    for (const code of ["NoCommit", "HashMismatch", "InvalidPath", "AlreadyRevealed", "RevealWindowClosed"]) {
      const m = await queued();
      m.s.sendError = new RelayChainError(code, code);
      await m.relay.flush();
      expect(m.relay.queueSize()).toBe(0);
      expect(m.s.sent.length).toBe(1);
    }
  });

  it("an entry the chain already shows as revealed is dropped without sending", async () => {
    const m = await queued({ pendingTtlMs: 60_000 });
    m.s.wait = "timeout";
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    m.commit(1n, WHO, PATH, SALT, { revealed: true });
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(0);
    expect(m.s.sent.length).toBe(1);
  });

  it("a sent reveal without a receipt (202 PENDING) keeps the queue entry until the chain shows it revealed", async () => {
    const m = await queued({ pendingTtlMs: 60_000 });
    m.s.wait = "timeout";
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
    expect(m.relay.queueSize()).toBe(1);
    await m.relay.flush(); // pending: looks at the chain, does not send again
    expect(m.s.sent.length).toBe(1);
    expect(m.relay.queueSize()).toBe(1);
    m.commit(1n, WHO, PATH, SALT, { revealed: true });
    await m.relay.flush();
    expect(m.relay.queueSize()).toBe(0);
    expect(m.s.sent.length).toBe(1);
  });

  it("a direct request that ends 202 PENDING does not remove the queue entry either", async () => {
    const m = await queued({ pendingTtlMs: 60_000 });
    m.s.wait = "timeout";
    expect(await m.relay.handle(req(body()))).toMatchObject({ status: 202, body: { code: "PENDING" } });
    expect(m.relay.queueSize()).toBe(1);
  });

  it("after the pending ttl and no reveal on chain, the flush tries again", async () => {
    const m = await queued({ pendingTtlMs: 60_000 });
    m.s.wait = "timeout";
    await m.relay.flush();
    m.s.wait = "success";
    m.clock.advance(61_000);
    await m.relay.flush();
    expect(m.s.sent.length).toBe(2);
    expect(m.relay.queueSize()).toBe(0);
  });

  it("a flush uses at most maxInFlight workers", async () => {
    const store = new MemoryQueueStore();
    const m = mk({ queueStore: store, maxInFlight: 2 });
    const whos = [1, 2, 3, 4, 5].map((i) => ("0x" + i.toString(16).padStart(40, "0")) as Address);
    for (const w of whos) m.commit(1n, w, PATH, SALT);
    store.save(whos.map((who) => ({ id: "1", who, path: PATH, salt: SALT, attempts: 0 })));
    const relay = createRelay({ chain: m.chain, queueStore: store, flushMs: 0, log: () => {}, maxInFlight: 2, nowMs: () => 1_000_000 });
    m.s.sendDelayMs = 5;
    await relay.flush();
    expect(m.s.sent.length).toBe(5);
    expect(m.s.maxActive).toBe(2);
    expect(relay.queueSize()).toBe(0);
  });

  it("queued humans do not make direct requests BUSY", async () => {
    const m = await queued({ maxInFlight: 1 });
    m.s.sendDelayMs = 20;
    const flushing = m.relay.flush();
    await new Promise((r) => setTimeout(r, 5));
    m.commit(1n, OTHER, PATH, OTHER_SALT);
    expect((await m.relay.handle(req(body({ who: OTHER, salt: OTHER_SALT })))).status).toBe(200);
    await flushing;
  });

  it("a direct request after commitEnd removes the entry from the queue (no double send from the flush)", async () => {
    const m = mk({ queueStore: new MemoryQueueStore() });
    m.s.now = COMMIT_END - 10;
    await m.relay.handle(req(body()));
    m.s.now = COMMIT_END + 2;
    expect((await m.relay.handle(req(body()))).status).toBe(200);
    expect(m.relay.queueSize()).toBe(0);
    await m.relay.flush();
    expect(m.s.sent.length).toBe(1);
  });

  it("the queue is bounded", async () => {
    const m = mk({ queueStore: new MemoryQueueStore(), maxQueue: 1 });
    m.commit(1n, OTHER, PATH, OTHER_SALT);
    m.s.now = COMMIT_END - 10;
    expect((await m.relay.handle(req(body()))).status).toBe(202);
    expect(await m.relay.handle(req(body({ who: OTHER, salt: OTHER_SALT })))).toMatchObject({ status: 503, body: { code: "QUEUE_FULL" } });
  });
});

describe("file queue store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "relay-queue-test-"));
    dirs.push(d);
    return join(d, "q", "queue.json");
  };

  it("round-trips entries, and starts empty without a file", () => {
    const store = new FileQueueStore(fresh());
    expect(store.load()).toEqual([]);
    store.save([{ id: "1", who: WHO, path: PATH, salt: SALT, attempts: 2 }]);
    expect(store.load()).toEqual([{ id: "1", who: WHO, path: PATH, salt: SALT, attempts: 2 }]);
  });

  it("refuses a corrupt or tampered file and leaves it untouched", () => {
    const f = fresh();
    const store = new FileQueueStore(f);
    store.save([]);
    for (const bad of ["nope", "{}", JSON.stringify([{ id: "1", who: "0x1", path: PATH, salt: SALT }])]) {
      writeFileSync(f, bad);
      expect(() => store.load()).toThrow(/corrupt|invalid/);
      expect(readFileSync(f, "utf8")).toBe(bad);
    }
  });
});

describe("relay over HTTP", () => {
  let relay: Relay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  async function serve(opts: Partial<RelayOptions> = {}) {
    const m = mk(opts);
    relay = m.relay;
    const { port } = await m.relay.listen(0, "127.0.0.1");
    return { ...m, url: `http://127.0.0.1:${port}` };
  }

  it("POST /reveal reveals through a real socket; GET /health works", async () => {
    const m = await serve();
    const r = await fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: body() });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, code: "REVEALED", tx: TX });
    expect(m.s.sent.length).toBe(1);
    expect((await fetch(`${m.url}/health`)).status).toBe(200);
  });

  it("malformed JSON over HTTP is 400, a wrong content type 415, an unknown path 404", async () => {
    const m = await serve();
    const post = (b: string, ct = "application/json") => fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": ct }, body: b });
    expect((await post("{not json")).status).toBe(400);
    expect((await post(body(), "text/plain")).status).toBe(415);
    expect((await fetch(`${m.url}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${m.url}/reveal`)).status).toBe(405);
    expect(m.s.sent.length).toBe(0);
  });

  it("an oversized body is refused with 413 and is not buffered (declared length)", async () => {
    const m = await serve({ maxBodyBytes: 1024 });
    const r = await fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(200_000) });
    expect(r.status).toBe(413);
    expect(m.s.reads).toBe(0);
  });

  it("an oversized chunked body (no Content-Length) is also cut off with 413", async () => {
    const m = await serve({ maxBodyBytes: 1024 });
    const chunks = (async function* () {
      for (let i = 0; i < 50; i++) yield new TextEncoder().encode("x".repeat(1000));
    })();
    const stream = new ReadableStream({
      async pull(c) {
        const n = await chunks.next();
        if (n.done) c.close();
        else c.enqueue(n.value);
      },
    });
    const r = await fetch(`${m.url}/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(m.s.reads).toBe(0);
  });

  it("CORS: only an allowed origin gets the header; preflight is answered", async () => {
    const m = await serve({ allowOrigins: ["https://app.example"] });
    const ok = await fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" }, body: "{}" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(`${m.url}/reveal`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/POST/);
  });

  it("the rate limit applies over HTTP (429 with Retry-After)", async () => {
    const m = await serve({ burst: 2, ratePerMin: 1 });
    const codes: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${m.url}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get("retry-after");
    }
    expect(codes).toEqual([400, 400, 429, 429]);
    expect(retry).not.toBeNull();
  });
});
