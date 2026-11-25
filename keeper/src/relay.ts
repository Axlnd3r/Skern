// Reveal relay (decision D1): a person who committed through the app may be offline when the reveal window
// opens, so the app sends `{id, who, path, salt}` here and the keeper wallet sends `reveal(id, who, path, salt)`
// for them. The commit hash binds `who`, so nobody else can make a valid reveal for that address.
//
//   POST /reveal   {"id": "12", "who": "0x..", "path": [{"close":..,"high":..,"low":..} x3], "salt": "0x..32 bytes"}
//   GET  /health
//   GET  /context/:id   the RoundContext (ticker, T, candleCount, recentCandlesBp) for house agents; see `contextOf`.
//                       Memory only: no chain read, no provider call. 400 malformed id, 404 unknown round.
//
// Trade-off (accepted in D1): the keeper sees a human's path from the moment it is submitted, before the
// reveal window. A request that arrives during the commit window is verified and QUEUED (202); the queue is
// flushed from `commitEnd` on. The queue file holds clear-text salts (0600) until the reveal.
//
// The relay pays gas for every reveal (about 349k), so it must never be an open gas sink. It only sends when:
//   - the body is small and well formed JSON, the path passes `isValid`, the client is within its rate limit,
//   - the round exists and the reveal window is not over,
//   - `who` has a commit of kind Human (agents reveal directly with their own wallet) that is not yet revealed
//     and whose on-chain hash equals `hashPath(path, salt, who)`,
//   - no reveal for the same (id, who) is in flight or recently sent and unconfirmed,
//   - the dry run succeeds and the gas estimate is below `MAX_REVEAL_GAS`.
// A reveal that was already done (also by someone who front-ran it with identical data) is success: no retry,
// no alert. Nothing is ever re-sent for the same (id, who) while a transaction may still be pending.
// A queued reveal is dropped only on a terminal answer (window over, revealed, NoCommit, HashMismatch, InvalidPath);
// RPC errors and failed sends are retried with a capped backoff until the window is over.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { RoundContext } from "../../agents/src/house/types";
import { hashPath } from "../../agents/src/salt";
import { isValid, type Candle, type Path } from "../../shared/score";
import type { Mutex } from "./lock";
import { arenaAbi, revertName, shortMessage, type KeeperDeps } from "./rounds";
import { StateError, writeFileAtomic } from "./state";

/** Reveal costs up to about 349k gas; anything above this estimate is refused, and it is also the gas limit cap. */
export const MAX_REVEAL_GAS = 600_000n;
const GAS_LIMIT_CAP = 700_000n;
/** After refusing an oversized body, this many more bytes are read and thrown away before the socket is cut. */
const DRAIN_LIMIT = 1024 * 1024;

// ---------------------------------------------------------------------------------------------- chain access

export class RelayChainError extends Error {
  constructor(
    /** An Arena custom error name (AlreadyRevealed, RevealWindowClosed, ...), or SIMULATION, GAS_TOO_HIGH, SEND_FAILED. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayChainError";
  }
}

export interface EntryView {
  /** 0 = no commit. */
  kind: number;
  revealed: boolean;
  hash: Hex;
}

export interface RelayChain {
  chainNow(): Promise<number>;
  roundCount(): Promise<bigint>;
  getRound(id: bigint): Promise<{ commitEnd: number; revealEnd: number }>;
  entryOf(id: bigint, who: Address): Promise<EntryView>;
  /** Dry run, gas check and send. Returns the tx hash. Throws `RelayChainError`. */
  sendReveal(id: bigint, who: Address, path: Path, salt: Hex): Promise<Hex>;
  waitReveal(hash: Hex): Promise<"success" | "reverted" | "timeout">;
}

/** The real chain access. Sends are serialized with the round loop through `lock` (one nonce sequence). */
export function createRelayChain(deps: KeeperDeps, lock: Mutex, receiptTimeoutMs = 60_000): RelayChain {
  const read = (functionName: string, args: readonly unknown[] = []): Promise<unknown> =>
    deps.publicClient.readContract({ address: deps.arenaAddress, abi: arenaAbi, functionName, args } as never) as Promise<unknown>;
  return {
    async chainNow() {
      return Number((await deps.publicClient.getBlock({ blockTag: "latest" })).timestamp);
    },
    async roundCount() {
      return (await read("roundCount")) as bigint;
    },
    async getRound(id) {
      const r = (await read("getRound", [id])) as { commitEnd: bigint; revealEnd: bigint };
      return { commitEnd: Number(r.commitEnd), revealEnd: Number(r.revealEnd) };
    },
    async entryOf(id, who) {
      const [kind, revealed, hash] = (await read("entryOf", [id, who])) as [number, boolean, Hex, unknown];
      return { kind: Number(kind), revealed, hash };
    },
    async sendReveal(id, who, path, salt) {
      const call = {
        address: deps.arenaAddress,
        abi: arenaAbi,
        functionName: "reveal",
        args: [id, who, path.map((c) => ({ close: c.close, high: c.high, low: c.low })), salt],
        account: deps.account,
      };
      let request: Record<string, unknown>;
      let est: bigint;
      try {
        const sim = await deps.publicClient.simulateContract(call as never);
        request = sim.request as unknown as Record<string, unknown>;
        est = await deps.publicClient.estimateContractGas(call as never);
      } catch (e) {
        const name = revertName(e);
        throw new RelayChainError(name ?? "SIMULATION", name ?? shortMessage(e));
      }
      if (est > MAX_REVEAL_GAS) throw new RelayChainError("GAS_TOO_HIGH", `gas estimate ${est} is above ${MAX_REVEAL_GAS}`);
      const padded = (est * 13n) / 10n;
      const gas = padded > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : padded;
      // Only the send is serialized; the receipt is awaited outside the lock so reveals overlap.
      return lock.run(async () => {
        try {
          return await deps.walletClient.writeContract({ ...request, gas } as never);
        } catch (e) {
          throw new RelayChainError("SEND_FAILED", shortMessage(e));
        }
      });
    },
    async waitReveal(hash) {
      try {
        const receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        return "timeout";
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- queue

export interface QueuedReveal {
  id: string;
  who: Address;
  path: Path;
  salt: Hex;
  /** Failed send attempts so far. */
  attempts: number;
}

export interface QueueStore {
  load(): QueuedReveal[];
  save(list: QueuedReveal[]): void;
}

export class MemoryQueueStore implements QueueStore {
  private data = "[]";
  load(): QueuedReveal[] {
    return JSON.parse(this.data) as QueuedReveal[];
  }
  save(list: QueuedReveal[]): void {
    this.data = JSON.stringify(list);
  }
}

/** JSON file, atomic replace, mode 0600. Entries are re-validated on load (a damaged file is refused, not trusted). */
export class FileQueueStore implements QueueStore {
  constructor(readonly file: string) {}
  load(): QueuedReveal[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StateError(`cannot read relay queue ${this.file}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new StateError(`relay queue ${this.file} is corrupt (not JSON); it was NOT modified`);
    }
    if (!Array.isArray(raw)) throw new StateError(`relay queue ${this.file} is corrupt (not a list); it was NOT modified`);
    const out: QueuedReveal[] = [];
    for (const item of raw) {
      const p = parseRevealRequest(JSON.stringify(item));
      if ("reject" in p) throw new StateError(`relay queue ${this.file} holds an invalid entry; it was NOT modified`);
      const attempts = Number((item as { attempts?: unknown }).attempts ?? 0);
      out.push({ id: p.id.toString(), who: p.who, path: p.path, salt: p.salt, attempts: Number.isSafeInteger(attempts) ? attempts : 0 });
    }
    return out;
  }
  save(list: QueuedReveal[]): void {
    writeFileAtomic(this.file, JSON.stringify(list) + "\n");
  }
}

// ---------------------------------------------------------------------------------------------- request parsing

export interface RevealRequest {
  id: bigint;
  who: Address;
  path: Path;
  salt: Hex;
}

interface Reject {
  reject: { status: number; code: string; message: string };
}

/** `Kind.Human` in Registry.sol (0 = None, 1 = Human, 2 = Agent). */
const KIND_HUMAN = 1;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Strict parse of the JSON body. Returns the typed request or a rejection (400). Never throws. */
export function parseRevealRequest(text: string): RevealRequest | Reject {
  const bad = (message: string): Reject => ({ reject: { status: 400, code: "BAD_REQUEST", message } });
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { reject: { status: 400, code: "BAD_JSON", message: "body is not valid JSON" } };
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return bad("body must be a JSON object");
  const o = j as Record<string, unknown>;

  let id: bigint;
  if (typeof o.id === "number" && Number.isSafeInteger(o.id) && o.id >= 1) id = BigInt(o.id);
  else if (typeof o.id === "string" && /^[1-9][0-9]{0,18}$/.test(o.id)) id = BigInt(o.id);
  else return bad("id must be a positive integer (number or decimal string)");

  if (typeof o.who !== "string" || !isAddress(o.who, { strict: false })) return bad("who must be an address");
  const who = getAddress(o.who);

  if (typeof o.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.salt)) return bad("salt must be 0x followed by 64 hex characters");

  if (!Array.isArray(o.path) || o.path.length !== 3) return bad("path must be a list of exactly 3 candles");
  const candles: Candle[] = [];
  for (let i = 0; i < 3; i++) {
    const c = o.path[i] as Record<string, unknown> | null | undefined;
    if (c === null || c === undefined || typeof c !== "object") return bad("each candle must be an object");
    const { close, high, low } = c;
    for (const v of [close, high, low]) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < INT32_MIN || v > INT32_MAX) return bad("candle fields must be int32 integers");
    }
    candles.push({ close: close as number, high: high as number, low: low as number });
  }
  return { id, who, salt: o.salt as Hex, path: [candles[0], candles[1], candles[2]] as unknown as Path };
}

// ---------------------------------------------------------------------------------------------- relay

export interface RelayOptions {
  chain: RelayChain;
  queueStore?: QueueStore;
  /** Default 4096 bytes. */
  maxBodyBytes?: number;
  /** Per client IP: sustained requests per minute (default 20) and burst (default 5). */
  ratePerMin?: number;
  burst?: number;
  /** All clients together (default 120 per minute). */
  globalPerMin?: number;
  /**
   * Reveals being sent or awaited at the same time (default 8): a limit for direct requests (503 BUSY above it)
   * and, separately, the number of workers a queue flush uses (so a big queue does not trigger RPC 429s itself).
   */
  maxInFlight?: number;
  /** Queued reveals (default 500). */
  maxQueue?: number;
  /** After a send without a confirmation, answer "pending" for this long instead of sending again (default 120 s). */
  pendingTtlMs?: number;
  /** Queue flush period; 0 = only when `flush()` is called (default 1000). */
  flushMs?: number;
  /** Exact origins allowed to call from a browser (CORS). Default none. */
  allowOrigins?: string[];
  /** Header carrying the client IP behind a trusted proxy (the LAST value is used). Default: the socket address. */
  clientIpHeader?: string;
  /**
   * Source of `GET /context/:id`: the round context for a round id, or undefined when the keeper has no such round
   * (404). It must be cheap and synchronous (in-memory state, no chain or provider call). Without it the route
   * does not exist (404 NOT_FOUND).
   */
  contextOf?: (id: bigint) => RoundContext | undefined;
  /** Context requests per client IP: sustained per minute (default 60) and burst (default 10). Separate from the reveal limit. */
  contextPerMin?: number;
  contextBurst?: number;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

export interface RelayResponse {
  status: number;
  body: { ok: boolean; code: string; message: string; tx?: string };
  /** Set by a successful `GET /context/:id`: the JSON sent on the wire INSTEAD of `body` (exactly a `RoundContext`). */
  json?: RoundContext;
}

export interface RelayRequest {
  method: string;
  path: string;
  ip: string;
  contentType?: string;
  body: string;
}

export interface Relay {
  handle(req: RelayRequest): Promise<RelayResponse>;
  /** Sends the queued reveals whose window is open; drops those whose window is over. Single-flight. */
  flush(): Promise<void>;
  queueSize(): number;
  listen(port?: number, host?: string): Promise<{ server: Server; port: number }>;
  close(): Promise<void>;
}

const res = (status: number, ok: boolean, code: string, message: string, tx?: string): RelayResponse => ({
  status,
  body: { ok, code, message, ...(tx ? { tx } : {}) },
});

interface Bucket {
  tokens: number;
  at: number;
}

export function createRelay(opts: RelayOptions): Relay {
  const chain = opts.chain;
  const maxBody = opts.maxBodyBytes ?? 4096;
  const ratePerMin = opts.ratePerMin ?? 20;
  const burst = opts.burst ?? 5;
  const globalPerMin = opts.globalPerMin ?? 120;
  const maxInFlight = opts.maxInFlight ?? 8;
  const maxQueue = opts.maxQueue ?? 500;
  const pendingTtl = opts.pendingTtlMs ?? 120_000;
  const flushMs = opts.flushMs ?? 1000;
  const allowOrigins = new Set(opts.allowOrigins ?? []);
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log ?? ((m: string) => console.log(`[relay] ${m}`));
  // Retry delay of a queued reveal after a transient failure: 250 ms doubling up to 2 s, so that many tries fit in
  // a short reveal window. A queued reveal is only ever removed on a terminal answer (see `flushOnce`).
  const BACKOFF_BASE_MS = 250;
  const BACKOFF_CAP_MS = 2000;

  const inFlight = new Set<string>();
  let directInFlight = 0;
  /** Not persisted: a restart simply retries at once. */
  const retryAt = new Map<string, number>();
  /** round id -> revealEnd, so an entry can still be dropped when the RPC is down at the end of the window. */
  const revealEndOf = new Map<string, number>();
  const pending = new Map<string, { hash: Hex; until: number }>();
  const keyOf = (id: bigint, who: Address): string => `${id}:${who.toLowerCase()}`;

  // -------- rate limiting (token buckets)
  const globalBucket: Bucket = { tokens: globalPerMin, at: nowMs() };
  const take = (b: Bucket, perMin: number, cap: number): boolean => {
    const now = nowMs();
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * perMin);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  /** A per-client token bucket limiter; the context endpoint has its own so polling agents never eat a reveal's budget. */
  const perIpLimiter = (perMin: number, cap: number): ((ip: string) => boolean) => {
    const map = new Map<string, Bucket>();
    return (ip: string): boolean => {
      if (map.size > 10_000) {
        // bound memory: forget the idlest half (a forgotten client simply starts with a full burst again)
        const old = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 5000);
        for (const [k] of old) map.delete(k);
      }
      let b = map.get(ip);
      if (!b) {
        b = { tokens: cap, at: nowMs() };
        map.set(ip, b);
      }
      return take(b, perMin, cap);
    };
  };
  const allow = perIpLimiter(ratePerMin, burst);
  const allowContext = perIpLimiter(opts.contextPerMin ?? 60, opts.contextBurst ?? 10);
  // The global bucket is charged only for a request that passed strict parsing and `isValid`, so junk from a few
  // clients cannot use up the budget of real reveals (the per-client bucket above already limits junk).
  const allowGlobal = (): boolean => take(globalBucket, globalPerMin, globalPerMin);

  // -------- queue
  let queue: QueuedReveal[] = opts.queueStore ? opts.queueStore.load() : [];
  const persist = (): void => opts.queueStore?.save(queue);
  const dequeue = (id: bigint, who: Address): void => {
    const before = queue.length;
    queue = queue.filter((q) => !(q.id === id.toString() && q.who.toLowerCase() === who.toLowerCase()));
    if (queue.length !== before) persist();
  };
  const prunePending = (): void => {
    if (pending.size < 1000) return;
    const now = nowMs();
    for (const [k, v] of pending) if (v.until <= now) pending.delete(k);
  };

  // -------- sending
  async function entryFor(id: bigint, who: Address): Promise<EntryView | undefined> {
    try {
      return await chain.entryOf(id, who);
    } catch {
      return undefined;
    }
  }

  /**
   * A final answer for a reveal: done (200), or the chain says it can never work (409 window over / no commit,
   * 422 hash mismatch / invalid path). Everything else (502, 503, 202 pending) may still succeed.
   */
  const isTerminal = (out: RelayResponse): boolean => out.status === 200 || out.status === 409 || out.status === 422;

  /** Sends one reveal that already passed every check. Never retries; never sends twice for one (id, who). */
  async function sendOne(req: RevealRequest): Promise<RelayResponse> {
    const key = keyOf(req.id, req.who);
    let hash: Hex;
    try {
      hash = await chain.sendReveal(req.id, req.who, req.path, req.salt);
    } catch (e) {
      const code = e instanceof RelayChainError ? e.code : "SEND_FAILED";
      if (code === "AlreadyRevealed") return res(200, true, "ALREADY_REVEALED", "already revealed");
      if (code === "RevealWindowClosed") return res(409, false, "WRONG_WINDOW", "the reveal window is not open");
      if (code === "NoCommit") return res(409, false, "NO_COMMIT", "no commit found for this address in this round");
      if (code === "HashMismatch" || code === "InvalidPath") return res(422, false, code === "InvalidPath" ? "INVALID_PATH" : "HASH_MISMATCH", "the commit does not match this path and salt");
      if (code === "GAS_TOO_HIGH") return res(502, false, "REVEAL_FAILED", "gas estimate is out of bounds");
      log(`reveal ${key}: send failed (${code})`);
      // The node may have accepted it despite the error: look at the chain instead of sending again.
      const after = await entryFor(req.id, req.who);
      if (after?.revealed) return res(200, true, "ALREADY_REVEALED", "already revealed");
      return res(502, false, "REVEAL_FAILED", "could not send the reveal; check again before retrying");
    }
    pending.set(key, { hash, until: nowMs() + pendingTtl });
    const outcome = await chain.waitReveal(hash);
    if (outcome === "success") {
      pending.delete(key);
      log(`reveal ${key}: revealed in ${hash}`);
      return res(200, true, "REVEALED", "revealed", hash);
    }
    if (outcome === "timeout") return res(202, true, "PENDING", "sent, not confirmed yet", hash);
    pending.delete(key);
    const after = await entryFor(req.id, req.who);
    if (after?.revealed) return res(200, true, "ALREADY_REVEALED", "already revealed"); // front-run with identical data
    log(`reveal ${key}: transaction ${hash} reverted`);
    return res(502, false, "REVEAL_FAILED", "the reveal transaction reverted");
  }

  /** Verifies a request against the chain. Returns a final response, "queue", or "send". */
  async function verify(req: RevealRequest, now: number): Promise<RelayResponse | "queue" | "send"> {
    const count = await chain.roundCount();
    if (req.id > count) return res(404, false, "UNKNOWN_ROUND", "no such round");
    const r = await chain.getRound(req.id);
    revealEndOf.set(req.id.toString(), r.revealEnd);
    if (now >= r.revealEnd) return res(409, false, "WRONG_WINDOW", "the reveal window is over");
    const e = await chain.entryOf(req.id, req.who);
    if (e.kind === 0) return res(409, false, "NO_COMMIT", "no commit found for this address in this round");
    // Gas is paid for humans only; agents reveal directly (SDK) with their own wallet.
    if (e.kind !== KIND_HUMAN) return res(403, false, "AGENT_NOT_RELAYED", "the relay reveals for humans only; agents reveal directly with their own wallet");
    if (e.revealed) return res(200, true, "ALREADY_REVEALED", "already revealed");
    if (hashPath(req.path, req.salt, req.who).toLowerCase() !== e.hash.toLowerCase()) {
      return res(422, false, "HASH_MISMATCH", "path, salt and address do not match the commit");
    }
    return now < r.commitEnd ? "queue" : "send";
  }

  async function reveal(body: string): Promise<RelayResponse> {
    const parsed = parseRevealRequest(body);
    if ("reject" in parsed) return res(parsed.reject.status, false, parsed.reject.code, parsed.reject.message);
    if (!isValid(parsed.path)) return res(422, false, "INVALID_PATH", "path is not valid: need low <= min(open, close) and high >= max(open, close)");

    if (!allowGlobal()) return res(429, false, "RATE_LIMITED", "too many requests");

    const key = keyOf(parsed.id, parsed.who);
    if (inFlight.has(key)) return res(409, false, "IN_FLIGHT", "a reveal for this address and round is already being processed");
    const p = pending.get(key);
    if (p && p.until > nowMs()) return res(202, true, "PENDING", "a reveal was sent and is not confirmed yet", p.hash);
    if (directInFlight >= maxInFlight) return res(503, false, "BUSY", "too many reveals in flight, retry shortly");

    inFlight.add(key);
    directInFlight += 1;
    try {
      let decision: RelayResponse | "queue" | "send";
      try {
        decision = await verify(parsed, await chain.chainNow());
      } catch {
        return res(503, false, "RPC_ERROR", "the chain is not reachable right now, retry shortly");
      }
      if (decision === "queue") {
        if (queue.some((q) => q.id === parsed.id.toString() && q.who.toLowerCase() === parsed.who.toLowerCase())) {
          return res(202, true, "QUEUED", "queued; it will be revealed when the reveal window opens");
        }
        if (queue.length >= maxQueue) return res(503, false, "QUEUE_FULL", "the reveal queue is full");
        queue.push({ id: parsed.id.toString(), who: parsed.who, path: parsed.path, salt: parsed.salt, attempts: 0 });
        persist();
        return res(202, true, "QUEUED", "queued; it will be revealed when the reveal window opens");
      }
      if (decision === "send") {
        prunePending();
        const out = await sendOne(parsed);
        // Only a final answer removes the queue entry. A 202 (sent, receipt not seen) keeps it: the flush removes
        // it once the chain shows the reveal, and the pending map is memory-only.
        if (isTerminal(out)) dequeue(parsed.id, parsed.who);
        return out;
      }
      return decision;
    } finally {
      directInFlight -= 1;
      inFlight.delete(key);
    }
  }

  // -------- queue flush
  let flushing: Promise<void> | undefined;
  async function flushOnce(): Promise<void> {
    if (queue.length === 0) return;
    let now: number;
    try {
      now = await chain.chainNow();
    } catch {
      return; // retry on the next flush
    }
    const batch = [...queue];
    const remove = new Set<QueuedReveal>();

    const retryLater = (q: QueuedReveal, key: string): void => {
      q.attempts += 1;
      retryAt.set(key, nowMs() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(q.attempts - 1, 10)));
    };

    /**
     * An entry leaves the queue only on a terminal answer: the window is over, the chain shows the reveal, or the
     * chain refuses it for good (no commit, hash mismatch, invalid path). A transient failure (RPC down or
     * rate-limited, send failed, receipt not seen) keeps it and retries with a capped backoff until revealEnd,
     * however many attempts that takes: dropping it earlier would burn the stake of someone who is offline.
     */
    const processEntry = async (q: QueuedReveal): Promise<void> => {
      const id = BigInt(q.id);
      const key = keyOf(id, q.who);
      if (inFlight.has(key)) return;
      if ((retryAt.get(key) ?? 0) > nowMs()) return;
      inFlight.add(key);
      try {
        const sent = pending.get(key);
        if (sent && sent.until > nowMs()) {
          // Sent already (a direct request, or an earlier flush without a receipt): wait for the chain to show it.
          if ((await entryFor(id, q.who))?.revealed) remove.add(q);
          return;
        }
        let r: { commitEnd: number; revealEnd: number };
        try {
          r = await chain.getRound(id);
        } catch {
          const known = revealEndOf.get(q.id);
          if (known !== undefined && now >= known) {
            log(`queued reveal ${key}: window over, dropped`);
            remove.add(q);
          } else {
            retryLater(q, key);
          }
          return;
        }
        revealEndOf.set(q.id, r.revealEnd);
        if (now >= r.revealEnd) {
          log(`queued reveal ${key}: window over, dropped`);
          remove.add(q);
          return;
        }
        if (now < r.commitEnd) return; // not yet
        const out = await sendOne({ id, who: q.who, path: q.path, salt: q.salt });
        if (isTerminal(out)) {
          remove.add(q);
          if (out.status !== 200) log(`queued reveal ${key}: refused by the chain (${out.body.code}), dropped`);
        } else if (out.status !== 202) {
          retryLater(q, key);
        }
        // 202: sent, no receipt yet. Kept; the next flush looks at the chain instead of sending again.
      } catch {
        retryLater(q, key);
      } finally {
        inFlight.delete(key);
      }
    };

    // A bounded pool of workers: a big queue must not fire hundreds of RPC calls at once.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batch.length) {
        const q = batch[next++] as QueuedReveal;
        await processEntry(q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxInFlight, batch.length) }, worker));
    for (const q of remove) retryAt.delete(keyOf(BigInt(q.id), q.who));
    queue = queue.filter((q) => !remove.has(q));
    persist();
  }
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = flushOnce().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  // -------- context (read only, memory only)
  function context(req: RelayRequest): RelayResponse {
    if (req.method !== "GET") return res(405, false, "METHOD_NOT_ALLOWED", "use GET");
    if (!allowContext(req.ip)) return res(429, false, "RATE_LIMITED", "too many requests");
    const raw = req.path.slice("/context/".length);
    if (!/^[1-9][0-9]{0,18}$/.test(raw)) return res(400, false, "BAD_REQUEST", "id must be a positive decimal integer");
    let ctx: RoundContext | undefined;
    try {
      ctx = (opts.contextOf as (id: bigint) => RoundContext | undefined)(BigInt(raw));
    } catch {
      return res(500, false, "INTERNAL", "internal error");
    }
    if (!ctx) return res(404, false, "UNKNOWN_ROUND", "no such round");
    return { status: 200, body: { ok: true, code: "OK", message: "ok" }, json: ctx };
  }

  // -------- request routing (no sockets)
  async function handle(req: RelayRequest): Promise<RelayResponse> {
    if (req.path === "/health") {
      return req.method === "GET" ? res(200, true, "OK", "ok") : res(405, false, "METHOD_NOT_ALLOWED", "use GET");
    }
    if (opts.contextOf && req.path.startsWith("/context/")) return context(req);
    if (req.path !== "/reveal") return res(404, false, "NOT_FOUND", "unknown path");
    if (req.method !== "POST") return res(405, false, "METHOD_NOT_ALLOWED", "use POST");
    if (!allow(req.ip)) return res(429, false, "RATE_LIMITED", "too many requests"); // per client; the global bucket is charged in `reveal`
    if (Buffer.byteLength(req.body, "utf8") > maxBody) return res(413, false, "TOO_LARGE", `body is larger than ${maxBody} bytes`);
    if (!/^application\/json\b/i.test(req.contentType ?? "")) return res(415, false, "UNSUPPORTED_MEDIA_TYPE", "send application/json");
    return reveal(req.body);
  }

  // -------- HTTP server
  let server: Server | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const clientIp = (req: IncomingMessage): string => {
    if (opts.clientIpHeader) {
      const h = req.headers[opts.clientIpHeader.toLowerCase()];
      const v = Array.isArray(h) ? h[h.length - 1] : h;
      const last = v?.split(",").pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const send = (rq: IncomingMessage, rs: ServerResponse, r: RelayResponse, extra: Record<string, string> = {}): void => {
    const origin = rq.headers.origin;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    };
    if (origin && allowOrigins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    if (r.status === 429) headers["retry-after"] = "10";
    rs.writeHead(r.status, headers);
    rs.end(JSON.stringify(r.json ?? r.body));
  };

  const onRequest = (rq: IncomingMessage, rs: ServerResponse): void => {
    const path = (rq.url ?? "").split("?")[0] ?? "";
    const isContextPath = opts.contextOf !== undefined && path.startsWith("/context/");
    if (rq.method === "OPTIONS" && (path === "/reveal" || isContextPath)) {
      const origin = rq.headers.origin;
      const headers: Record<string, string> = { "content-length": "0" };
      if (origin && allowOrigins.has(origin)) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-methods"] = isContextPath ? "GET, OPTIONS" : "POST, OPTIONS";
        headers["access-control-allow-headers"] = "content-type";
        headers["access-control-max-age"] = "600";
        headers.vary = "Origin";
      }
      rs.writeHead(204, headers);
      rs.end();
      return;
    }
    const declared = Number(rq.headers["content-length"] ?? "0");
    const chunks: Buffer[] = [];
    let size = 0;
    let discarded = 0;
    let tooLarge = false;
    // Answer 413 at once, never buffer the body, and drain at most DRAIN_LIMIT more bytes so the client can
    // read the answer instead of seeing a reset; then cut the connection.
    const refuse = (): void => {
      tooLarge = true;
      chunks.length = 0;
      send(rq, rs, res(413, false, "TOO_LARGE", `body is larger than ${maxBody} bytes`), { connection: "close" });
      const cut = setTimeout(() => rq.socket.destroy(), 2000);
      cut.unref();
      rs.once("close", () => clearTimeout(cut));
    };
    if (rq.method === "POST" && Number.isFinite(declared) && declared > maxBody) refuse();
    rq.on("data", (c: Buffer) => {
      if (tooLarge) {
        discarded += c.length;
        if (discarded > DRAIN_LIMIT) rq.socket.destroy();
        return;
      }
      size += c.length;
      if (size > maxBody) {
        refuse();
        return;
      }
      chunks.push(c);
    });
    rq.on("error", () => {
      /* the client went away */
    });
    rq.on("end", () => {
      if (tooLarge) return;
      void handle({
        method: rq.method ?? "GET",
        path,
        ip: clientIp(rq),
        contentType: rq.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      })
        .then((r) => send(rq, rs, r))
        .catch(() => send(rq, rs, res(500, false, "INTERNAL", "internal error")));
    });
  };

  return {
    handle,
    flush,
    queueSize: () => queue.length,
    async listen(port = 0, host = "127.0.0.1") {
      if (server) throw new Error("relay is already listening");
      const s = createServer(onRequest);
      s.requestTimeout = 10_000;
      s.headersTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(port, host, () => resolve());
      });
      server = s;
      if (flushMs > 0) {
        flushTimer = setInterval(() => void flush(), flushMs);
        flushTimer.unref();
      }
      return { server: s, port: (s.address() as AddressInfo).port };
    },
    async close() {
      if (flushTimer) clearInterval(flushTimer);
      const s = server;
      server = undefined;
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}
