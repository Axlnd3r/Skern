import type { Address, Hash, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Path } from "../../../shared/score";
import { commitHash } from "./commitHash";
import { MemoryKV, createInflightStore } from "./inflight";
import { afterCommit, runArenaClaim, runCommit, runJoin, runManualReveal, runRelay, type ActionDeps, type ChainCall, type RelayState } from "./actionTx";
import type { TxState } from "./marketTx";
import type { EntryHead, PlayerReads } from "./player";
import type { RelayOutcome, RelayRequest } from "./relayClient";
import type { Phase, RoundView } from "./round";
import { createSaltStore } from "./saltStore";

const WHO = "0x4444444444444444444444444444444444444444" as Address;
const ARENA = "0x4Da1FBb0f99D27F566Aa08243A4D6B8276E69AB7" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const SALT = `0x${"11".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const PATH: Path = [
  { close: 10, high: 20, low: -5 },
  { close: 5, high: 30, low: -10 },
  { close: 0, high: 12, low: -12 },
];
const FLAT: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];

function round(phase: Phase = "commit", closing = false): RoundView {
  return {
    status: "ready",
    params: { ticker: `0x${"00".repeat(32)}`, p0: 1n, T: 100, commitEnd: 1n, revealEnd: 2n, marketEnd: 3n, candleSec: 10, settleDeadline: 99n, entryStake: 50n },
    phase,
    countdownSec: 60,
    closing,
    blockTime: 1000n,
  };
}

function reads(over: Partial<PlayerReads> = {}): PlayerReads {
  return {
    kind: 1,
    allowlisted: true,
    balance: 1000n,
    starterGrant: 1000n,
    entry: { kind: 0, revealed: false, hash: ZERO_HASH, path: FLAT },
    claimed: false,
    rewardPerPoint: 1n,
    ...over,
  };
}

const committedEntry = (hash: Hex, revealed = false): EntryHead => ({ kind: 1, revealed, hash, path: revealed ? PATH : FLAT });

type H = {
  deps: ActionDeps;
  log: string[];
  sims: ChainCall[];
  relays: RelayRequest[];
  tx: TxState[];
  relay: RelayState[];
  setTx: (s: TxState) => void;
  setRelay: (s: RelayState) => void;
  kv: MemoryKV;
  inflight: ReturnType<typeof createInflightStore>;
  salts: ReturnType<typeof createSaltStore>;
  writes: { savedAtWrite: unknown }[];
};

function harness(
  opts: {
    round?: RoundView;
    reads?: PlayerReads | null;
    account?: { address: Address | undefined; isConnected: boolean; chainId: number | undefined };
    simulate?: () => Promise<unknown>;
    wait?: () => Promise<{ ok: boolean; replaced?: boolean }>;
    write?: () => Promise<Hash>;
    newSalt?: Hex;
    relay?: (r: RelayRequest) => Promise<RelayOutcome>;
    kv?: MemoryKV;
    readFresh?: () => Promise<{ round: RoundView | undefined; reads: PlayerReads | null }>;
  } = {},
): H {
  const kv = opts.kv ?? new MemoryKV();
  const inflight = createInflightStore(kv, 84532, () => 1000);
  const salts = createSaltStore(kv, 84532, ARENA, () => 1000);
  const log: string[] = [];
  const sims: ChainCall[] = [];
  const relays: RelayRequest[] = [];
  const writes: H["writes"] = [];
  const h: H = {
    log,
    sims,
    relays,
    tx: [],
    relay: [],
    setTx: (s) => h.tx.push(s),
    setRelay: (s) => h.relay.push(s),
    kv,
    inflight,
    salts,
    writes,
    deps: {
      chainId: 84532,
      account: () => opts.account ?? { address: WHO, isConnected: true, chainId: 84532 },
      readFresh:
        opts.readFresh ??
        (async () => {
          log.push("read");
          return { round: opts.round ?? round(), reads: opts.reads === undefined ? reads() : opts.reads };
        }),
      simulate: async (call) => {
        log.push("simulate");
        sims.push(call);
        return opts.simulate ? opts.simulate() : { request: "prepared" };
      },
      write: async () => {
        log.push("write");
        writes.push({ savedAtWrite: salts.load(7n, WHO) });
        return opts.write ? opts.write() : HASH;
      },
      waitReceipt: async () => {
        log.push("wait");
        return opts.wait ? opts.wait() : { ok: true };
      },
      inflight,
      salts,
      newSalt: () => opts.newSalt ?? SALT,
      relay: async (r) => {
        log.push("relay");
        relays.push(r);
        return opts.relay ? opts.relay(r) : { state: "queued" };
      },
    },
  };
  return h;
}

const lastTx = (h: H) => h.tx[h.tx.length - 1] as TxState;
const lastRelay = (h: H) => h.relay[h.relay.length - 1] as RelayState;
const steps = (h: H) => h.log.filter((x) => x !== "read");
const failedMsg = (h: H) => {
  const s = lastTx(h);
  return s.step === "failed" ? s.message : "";
};

describe("join as human", () => {
  const fresh = reads({ kind: 0, balance: 0n });
  it("dry-runs and sends Registry.registerHuman for an allowlisted unregistered wallet, then clears the in-flight record", async () => {
    const h = harness({ reads: fresh });
    await runJoin(h.deps, h.setTx);
    expect(h.sims).toEqual([{ contract: "registry", functionName: "registerHuman", args: [], who: WHO }]);
    expect(steps(h)).toEqual(["simulate", "write", "wait"]);
    expect(lastTx(h)).toMatchObject({ step: "confirmed", hash: HASH });
    expect(h.inflight.get(undefined, WHO, "join")).toBeNull();
  });
  it("says plainly that a wallet that is not allowlisted cannot join, and sends nothing", async () => {
    const h = harness({ reads: reads({ kind: 0, balance: 0n, allowlisted: false }) });
    await runJoin(h.deps, h.setTx);
    expect(failedMsg(h)).toMatch(/allowlist/i);
    expect(steps(h)).toEqual([]);
  });
  it("does not send for an already registered wallet or an unreadable account", async () => {
    const a = harness({ reads: reads() });
    await runJoin(a.deps, a.setTx);
    expect(failedMsg(a)).toMatch(/already/i);
    expect(steps(a)).toEqual([]);
    const b = harness({ reads: null });
    await runJoin(b.deps, b.setTx);
    expect(failedMsg(b)).toMatch(/could not read/i);
    expect(steps(b)).toEqual([]);
  });
  it("never sends on another chain or without a wallet", async () => {
    const wrong = harness({ reads: fresh, account: { address: WHO, isConnected: true, chainId: 1 } });
    await runJoin(wrong.deps, wrong.setTx);
    expect(failedMsg(wrong)).toMatch(/Base Sepolia/);
    expect(wrong.log).toEqual([]);
    const off = harness({ reads: fresh, account: { address: undefined, isConnected: false, chainId: undefined } });
    await runJoin(off.deps, off.setTx);
    expect(off.log).toEqual([]);
  });
  it("a pending transaction from a reload blocks a second send", async () => {
    const h = harness({ reads: fresh });
    h.inflight.set(undefined, WHO, "join", { action: "join", label: "Join as human", hash: HASH });
    await runJoin(h.deps, h.setTx);
    expect(h.log).toEqual([]);
    expect(lastTx(h)).toMatchObject({ step: "unconfirmed", hash: HASH });
  });
  it("a revert of the dry run (for example NotHuman from a swapped gate) is explained and nothing is sent", async () => {
    const h = harness({ reads: fresh, simulate: () => Promise.reject(Object.assign(new Error("x"), { name: "ContractFunctionExecutionError" })) });
    await runJoin(h.deps, h.setTx);
    expect(lastTx(h).step).toBe("failed");
    expect(h.log).not.toContain("write");
  });
});

describe("commit", () => {
  it("saves path and salt BEFORE the transaction, commits keccak(path, salt, who), then sends path and salt to the relay", async () => {
    const h = harness();
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    const hash = commitHash(PATH, SALT, WHO);
    expect(h.sims).toEqual([{ contract: "arena", functionName: "commit", args: [7n, hash], who: WHO }]);
    expect(steps(h)).toEqual(["simulate", "write", "wait", "relay"]);
    // at the moment of the write the record already existed with the exact data
    const atWrite = h.writes[0]?.savedAtWrite as { state: string; record: { id: bigint; who: Address; path: Path; salt: Hex; hash: Hex } };
    expect(atWrite.state).toBe("found");
    expect(atWrite.record).toMatchObject({ id: 7n, who: WHO, path: PATH, salt: SALT, hash });
    expect(h.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT }]);
    expect(lastTx(h)).toMatchObject({ step: "confirmed", hash: HASH });
    expect(lastRelay(h)).toEqual({ step: "done", outcome: { state: "queued" } });
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record).toMatchObject({ status: "committed", commitTx: HASH, relayAck: true });
    expect(h.inflight.get(7n, WHO, "entry")).toBeNull();
  });

  it("does not save anything or send when a precondition fails (not registered, low points, closing, already committed)", async () => {
    const cases: [Partial<PlayerReads>, RoundView, RegExp][] = [
      [{ kind: 0 }, round(), /join as human/i],
      [{ balance: 49n }, round(), /not enough points/i],
      [{}, round("commit", true), /closing/i],
      [{}, round("reveal"), /commit window/i],
      [{ entry: committedEntry(HASH) }, round(), /already committed/i],
    ];
    for (const [over, r, re] of cases) {
      const h = harness({ reads: reads(over), round: r });
      await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
      expect(failedMsg(h)).toMatch(re);
      expect(steps(h)).toEqual([]);
      expect(h.salts.load(7n, WHO)).toEqual({ state: "none" });
    }
  });

  it("never sends on another chain or without a wallet, and reads nothing", async () => {
    const wrong = harness({ account: { address: WHO, isConnected: true, chainId: 1 } });
    await runCommit(wrong.deps, { id: 7n, path: PATH }, wrong.setTx, wrong.setRelay);
    expect(failedMsg(wrong)).toMatch(/Base Sepolia/);
    expect(wrong.log).toEqual([]);
    const off = harness({ account: { address: WHO, isConnected: false, chainId: 84532 } });
    await runCommit(off.deps, { id: 7n, path: PATH }, off.setTx, off.setRelay);
    expect(off.log).toEqual([]);
  });

  it("refuses an invalid path", async () => {
    const h = harness();
    const bad = [{ close: 0, high: -5, low: 0 }, ...PATH.slice(1)] as unknown as Path;
    await runCommit(h.deps, { id: 7n, path: bad }, h.setTx, h.setRelay);
    expect(failedMsg(h)).toMatch(/not valid/i);
    expect(steps(h)).toEqual([]);
  });

  it("does not send when the salt cannot be saved (storage blocked), so the salt is never lost", async () => {
    const h = harness();
    h.deps.salts = createSaltStore(null, 84532, ARENA);
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(failedMsg(h)).toMatch(/save|storage/i);
    expect(failedMsg(h)).toMatch(/nothing was sent/i);
    expect(steps(h)).toEqual([]);
  });

  it("does not touch a damaged saved record and does not send", async () => {
    const h = harness();
    h.kv.setItem(`consensus-path:salt:v1:84532:${ARENA.toLowerCase()}:7:${WHO.toLowerCase()}`, "{broken");
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(failedMsg(h)).toMatch(/unreadable|damaged/i);
    expect(steps(h)).toEqual([]);
  });

  it("never overwrites the salt of an earlier commit attempt that was sent", async () => {
    const other = `0x${"22".repeat(32)}` as Hex;
    const otherHash = commitHash(PATH, other, WHO);
    const sent = harness();
    sent.salts.save({ id: 7n, who: WHO, path: PATH, salt: other, hash: otherHash });
    sent.salts.patch(7n, WHO, { hash: otherHash }, { status: "sent", commitTx: HASH });
    await runCommit(sent.deps, { id: 7n, path: PATH }, sent.setTx, sent.setRelay);
    expect(steps(sent)).toEqual([]);
    expect(failedMsg(sent)).toMatch(/earlier|previous/i);
    const kept = sent.salts.load(7n, WHO, otherHash);
    expect(kept.state === "found" && kept.record.salt).toBe(other);
    expect(sent.salts.list(7n, WHO).records).toHaveLength(1);
  });

  it("an earlier attempt that was never sent is KEPT, not replaced: both salts stay findable by hash", async () => {
    const other = `0x${"22".repeat(32)}` as Hex;
    const otherHash = commitHash(PATH, other, WHO);
    const unsent = harness();
    unsent.salts.save({ id: 7n, who: WHO, path: PATH, salt: other, hash: otherHash });
    await runCommit(unsent.deps, { id: 7n, path: PATH }, unsent.setTx, unsent.setRelay);
    expect(unsent.log).toContain("write");
    const mine = unsent.salts.load(7n, WHO, commitHash(PATH, SALT, WHO));
    expect(mine.state === "found" && mine.record.salt).toBe(SALT);
    const earlier = unsent.salts.load(7n, WHO, otherHash);
    expect(earlier.state === "found" && earlier.record.salt).toBe(other);
  });

  it("two commit attempts (two tabs, one wallet): the salt of the one that lands is never lost, relayed or revealed", async () => {
    const kv = new MemoryKV();
    const SALT_B = `0x${"22".repeat(32)}` as Hex;
    const hashA = commitHash(PATH, SALT, WHO);
    const hashB = commitHash(PATH, SALT_B, WHO);
    const TX_A = `0x${"aa".repeat(32)}` as Hash;
    const TX_B = `0x${"bb".repeat(32)}` as Hash;
    let approveA!: (h: Hash) => void;
    const walletPromptA = new Promise<Hash>((r) => (approveA = r));

    // Tab A saves its salt and waits in the wallet prompt.
    const a = harness({ kv, newSalt: SALT, write: () => walletPromptA });
    const runA = runCommit(a.deps, { id: 7n, path: PATH }, a.setTx, a.setRelay);
    await vi.waitFor(() => expect(a.log).toContain("write"));

    // Tab B (same wallet, the chain still shows no entry) saves another salt and sends its own commit.
    const b = harness({ kv, newSalt: SALT_B, write: async () => TX_B, wait: () => Promise.reject(new Error("HTTP 429")) });
    await runCommit(b.deps, { id: 7n, path: PATH }, b.setTx, b.setRelay);
    expect(b.log).toContain("write");

    // The user approves A: keccak(path, S_A, who) is what lands on chain.
    approveA(TX_A);
    await runA;

    // A relayed ITS salt, and its record is the one marked committed.
    expect(a.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT }]);
    const landed = a.salts.load(7n, WHO, hashA);
    expect(landed.state === "found" && landed.record).toMatchObject({ salt: SALT, status: "committed", commitTx: TX_A });
    // B's salt is still there, untouched by A's patches.
    const other = a.salts.load(7n, WHO, hashB);
    expect(other.state === "found" && other.record).toMatchObject({ salt: SALT_B, status: "sent", commitTx: TX_B });

    // Later, with the chain showing A's hash: the relay button and the manual reveal both use S_A.
    const relayLater = harness({ kv, round: round("reveal"), reads: reads({ entry: committedEntry(hashA) }) });
    await runRelay(relayLater.deps, { id: 7n }, relayLater.setRelay);
    expect(relayLater.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT }]);
    const revealLater = harness({ kv, round: round("reveal"), reads: reads({ entry: committedEntry(hashA) }) });
    await runManualReveal(revealLater.deps, { id: 7n }, revealLater.setTx);
    expect(revealLater.sims).toEqual([{ contract: "arena", functionName: "reveal", args: [7n, WHO, PATH, SALT], who: WHO }]);
    // ... and when B's commit is the one on chain, S_B is used.
    const relayB = harness({ kv, round: round("reveal"), reads: reads({ entry: committedEntry(hashB) }) });
    await runRelay(relayB.deps, { id: 7n }, relayB.setRelay);
    expect(relayB.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT_B }]);
  });

  it("a commit that was replaced or cancelled in the wallet is not confirmed: nothing relayed, record kept as pending, commit retryable", async () => {
    const SALT_B = `0x${"22".repeat(32)}` as Hex;
    const h = harness({ wait: async () => ({ ok: false, replaced: true }) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastTx(h).step).toBe("failed");
    expect(failedMsg(h)).toMatch(/replaced|cancelled/i);
    expect(h.log).not.toContain("relay");
    expect(h.tx.some((s) => s.step === "confirmed")).toBe(false);
    const rec = h.salts.load(7n, WHO, commitHash(PATH, SALT, WHO));
    expect(rec.state === "found" && rec.record).toMatchObject({ salt: SALT, status: "pending" });
    expect(rec.state === "found" && rec.record.commitTx).toBeUndefined();
    expect(h.inflight.get(7n, WHO, "entry")).toBeNull();

    // The user is not locked out: a new attempt works, and the old salt stays.
    const retry = harness({ kv: h.kv, newSalt: SALT_B });
    await runCommit(retry.deps, { id: 7n, path: PATH }, retry.setTx, retry.setRelay);
    expect(retry.log).toContain("write");
    expect(retry.salts.list(7n, WHO).records.map((r) => r.salt).sort()).toEqual([SALT, SALT_B]);
  });

  it("after a reload only the commit transaction is known: its record is committed and relayed, another record is not", async () => {
    const SALT_B = `0x${"22".repeat(32)}` as Hex;
    const h = harness();
    h.salts.save({ id: 7n, who: WHO, path: PATH, salt: SALT, hash: commitHash(PATH, SALT, WHO) });
    h.salts.save({ id: 7n, who: WHO, path: PATH, salt: SALT_B, hash: commitHash(PATH, SALT_B, WHO) });
    h.salts.patch(7n, WHO, { hash: commitHash(PATH, SALT_B, WHO) }, { status: "sent", commitTx: HASH });
    await afterCommit(h.deps, 7n, WHO, "confirmed", h.setRelay, HASH);
    expect(h.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT_B }]);
    const b = h.salts.load(7n, WHO, commitHash(PATH, SALT_B, WHO));
    expect(b.state === "found" && b.record).toMatchObject({ status: "committed", relayAck: true });
    const a = h.salts.load(7n, WHO, commitHash(PATH, SALT, WHO));
    expect(a.state === "found" && a.record.status).toBe("pending");
    // a transaction no record knows relays nothing
    const none = harness();
    await afterCommit(none.deps, 7n, WHO, "confirmed", none.setRelay, HASH);
    expect(none.relays).toEqual([]);
    expect(lastRelay(none).step).toBe("blocked");
  });

  it("a reverted dry run sends nothing and leaves the record replaceable", async () => {
    const h = harness({ simulate: () => Promise.reject(new Error("revert")) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastTx(h).step).toBe("failed");
    expect(h.log).not.toContain("write");
    expect(h.log).not.toContain("relay");
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record.status).toBe("pending");
  });

  it("a mined revert is failed, nothing is relayed, and the record can be replaced again", async () => {
    const h = harness({ wait: async () => ({ ok: false }) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastTx(h).step).toBe("failed");
    expect(h.log).not.toContain("relay");
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record.commitTx).toBeUndefined();
    expect(h.inflight.get(7n, WHO, "entry")).toBeNull();
  });

  it("a receipt lookup error is unconfirmed: hash and record kept, no relay, no second send", async () => {
    const h = harness({ wait: () => Promise.reject(new Error("HTTP 429")) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastTx(h)).toMatchObject({ step: "unconfirmed", hash: HASH });
    expect(h.log).not.toContain("relay");
    expect(h.inflight.get(7n, WHO, "entry")).toMatchObject({ hash: HASH, action: "arena:commit" });
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record).toMatchObject({ status: "sent", commitTx: HASH });
    // a second click (or a second tab) sends nothing
    const again = harness({ kv: h.kv });
    await runCommit(again.deps, { id: 7n, path: PATH }, again.setTx, again.setRelay);
    expect(again.log).toEqual([]);
    expect(lastTx(again)).toMatchObject({ step: "unconfirmed", hash: HASH });
  });

  it("an unreachable relay does not hide that the commit is confirmed, and says what to do", async () => {
    const h = harness({ relay: async () => ({ state: "unavailable", message: "The reveal relay is not available. Reveal yourself." }) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastTx(h).step).toBe("confirmed");
    expect(lastRelay(h)).toMatchObject({ step: "done", outcome: { state: "unavailable" } });
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record.relayAck).toBeUndefined();
  });

  it("a relay that throws is reported as unavailable, never as success", async () => {
    const h = harness({ relay: () => Promise.reject(new Error("boom")) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastRelay(h)).toMatchObject({ step: "done", outcome: { state: "unavailable" } });
  });

  it("202 PENDING counts as in progress and is acknowledged", async () => {
    const h = harness({ relay: async () => ({ state: "pending" }) });
    await runCommit(h.deps, { id: 7n, path: PATH }, h.setTx, h.setRelay);
    expect(lastRelay(h)).toEqual({ step: "done", outcome: { state: "pending" } });
    const rec = h.salts.load(7n, WHO);
    expect(rec.state === "found" && rec.record.relayAck).toBe(true);
  });
});

describe("relay (send the saved path again)", () => {
  function committed(hh: Partial<{ phase: Phase; closing: boolean; entry: EntryHead; skip: boolean; hash: Hex }> = {}) {
    const hash = hh.hash ?? commitHash(PATH, SALT, WHO);
    const h = harness({
      round: round(hh.phase ?? "reveal", hh.closing ?? false),
      reads: reads({ entry: hh.entry ?? committedEntry(hash) }),
    });
    if (!hh.skip) h.salts.save({ id: 7n, who: WHO, path: PATH, salt: SALT, hash: commitHash(PATH, SALT, WHO) });
    return h;
  }
  it("posts the saved record when the commit is on chain, unrevealed and the window is open", async () => {
    const h = committed();
    await runRelay(h.deps, { id: 7n }, h.setRelay);
    expect(h.relays).toEqual([{ id: 7n, who: WHO, path: PATH, salt: SALT }]);
    expect(lastRelay(h)).toEqual({ step: "done", outcome: { state: "queued" } });
  });
  it("posts nothing when there is no record, the chain shows another hash, it is revealed, or the window is over", async () => {
    for (const h of [
      committed({ skip: true }),
      committed({ entry: committedEntry(`0x${"99".repeat(32)}`) }),
      committed({ entry: committedEntry(commitHash(PATH, SALT, WHO), true) }),
      committed({ phase: "market" }),
      committed({ phase: "reveal", closing: true }),
      committed({ entry: { kind: 0, revealed: false, hash: ZERO_HASH, path: FLAT } }),
    ]) {
      await runRelay(h.deps, { id: 7n }, h.setRelay);
      expect(h.relays).toEqual([]);
      expect(lastRelay(h).step).toBe("blocked");
    }
  });
  it("needs no wallet chain match (the relay pays), but needs the connected address", async () => {
    const h = committed();
    h.deps.account = () => ({ address: WHO, isConnected: true, chainId: 1 });
    await runRelay(h.deps, { id: 7n }, h.setRelay);
    expect(h.relays.length).toBe(1);
    const none = committed();
    none.deps.account = () => ({ address: undefined, isConnected: false, chainId: undefined });
    await runRelay(none.deps, { id: 7n }, none.setRelay);
    expect(none.relays).toEqual([]);
  });
});

describe("manual reveal (Arena.reveal(id, who, path, salt), anyone may reveal for who)", () => {
  function setup(phase: Phase = "reveal", closing = false, entryHash = commitHash(PATH, SALT, WHO), revealed = false) {
    const h = harness({ round: round(phase, closing), reads: reads({ entry: committedEntry(entryHash, revealed) }) });
    h.salts.save({ id: 7n, who: WHO, path: PATH, salt: SALT, hash: commitHash(PATH, SALT, WHO) });
    return h;
  }
  it("sends the saved path and salt for the connected wallet", async () => {
    const h = setup();
    await runManualReveal(h.deps, { id: 7n }, h.setTx);
    expect(h.sims).toEqual([{ contract: "arena", functionName: "reveal", args: [7n, WHO, PATH, SALT], who: WHO }]);
    expect(steps(h)).toEqual(["simulate", "write", "wait"]);
    expect(lastTx(h)).toMatchObject({ step: "confirmed" });
    expect(h.inflight.get(7n, WHO, "entry")).toBeNull();
  });
  it("refuses outside the reveal window, in its last seconds, on a hash mismatch, when already revealed, and without a record", async () => {
    const cases: [H, RegExp][] = [
      [setup("commit"), /reveal window/i],
      [setup("market"), /reveal window/i],
      [setup("reveal", true), /closing/i],
      [setup("reveal", false, `0x${"99".repeat(32)}`), /do not match/i],
      [setup("reveal", false, commitHash(PATH, SALT, WHO), true), /already/i],
    ];
    const none = harness({ round: round("reveal"), reads: reads({ entry: committedEntry(commitHash(PATH, SALT, WHO)) }) });
    cases.push([none, /saved path/i]);
    for (const [h, re] of cases) {
      await runManualReveal(h.deps, { id: 7n }, h.setTx);
      expect(failedMsg(h)).toMatch(re);
      expect(steps(h)).toEqual([]);
    }
  });
  it("never sends on another chain", async () => {
    const h = setup();
    h.deps.account = () => ({ address: WHO, isConnected: true, chainId: 1 });
    await runManualReveal(h.deps, { id: 7n }, h.setTx);
    expect(failedMsg(h)).toMatch(/Base Sepolia/);
    expect(h.log).toEqual([]);
  });
  it("a pending transaction blocks a second reveal", async () => {
    const h = setup();
    h.inflight.set(7n, WHO, "entry", { action: "reveal", label: "Reveal", hash: HASH });
    await runManualReveal(h.deps, { id: 7n }, h.setTx);
    expect(h.log).toEqual([]);
  });
});

describe("Arena.claim", () => {
  const claimable = (phase: Phase, over: Partial<PlayerReads> = {}) =>
    harness({ round: round(phase), reads: reads({ entry: committedEntry(HASH, true), claimed: false, ...over }) });
  it("claims a settled round with the round id as the only argument", async () => {
    const h = claimable("settled");
    await runArenaClaim(h.deps, { id: 7n }, h.setTx);
    expect(h.sims).toEqual([{ contract: "arena", functionName: "claim", args: [7n], who: WHO }]);
    expect(steps(h)).toEqual(["simulate", "write", "wait"]);
    expect(lastTx(h)).toMatchObject({ step: "confirmed" });
  });
  it("refunds a void round even when the entry was not revealed", async () => {
    const h = claimable("void", { entry: committedEntry(HASH, false) });
    await runArenaClaim(h.deps, { id: 7n }, h.setTx);
    expect(h.log).toContain("write");
  });
  it("sends nothing when the round is not final, already claimed, unrevealed, or has no entry", async () => {
    const cases: [H, RegExp][] = [
      [claimable("market"), /not final/i],
      [claimable("play"), /not final/i],
      [claimable("settled", { claimed: true }), /already/i],
      [claimable("settled", { claimed: undefined }), /could not read/i],
      [claimable("settled", { entry: committedEntry(HASH, false) }), /burned|not revealed/i],
      [claimable("settled", { entry: { kind: 0, revealed: false, hash: ZERO_HASH, path: FLAT } }), /no entry|no commit/i],
      [claimable("settled", { entry: null }), /could not read/i],
    ];
    for (const [h, re] of cases) {
      await runArenaClaim(h.deps, { id: 7n }, h.setTx);
      expect(failedMsg(h)).toMatch(re);
      expect(steps(h)).toEqual([]);
    }
  });
  it("never sends on another chain, and a pending transaction blocks a second claim", async () => {
    const wrong = claimable("settled");
    wrong.deps.account = () => ({ address: WHO, isConnected: true, chainId: 1 });
    await runArenaClaim(wrong.deps, { id: 7n }, wrong.setTx);
    expect(wrong.log).toEqual([]);
    const held = claimable("settled");
    held.inflight.set(7n, WHO, "arena-claim", { action: "claim", label: "Claim", hash: HASH });
    await runArenaClaim(held.deps, { id: 7n }, held.setTx);
    expect(held.log).toEqual([]);
    expect(lastTx(held).step).toBe("unconfirmed");
  });
  it("an unreadable round sends nothing", async () => {
    const h = harness({ readFresh: () => Promise.reject(new Error("rpc down")) });
    await runArenaClaim(h.deps, { id: 7n }, h.setTx);
    expect(failedMsg(h)).toMatch(/could not read/i);
    expect(steps(h)).toEqual([]);
  });
});
