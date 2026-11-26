import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { score } from "../../../shared/score";
import { commitHash } from "./commitHash";
import {
  commitPreflight,
  deriveClaim,
  deriveEntry,
  deriveJoin,
  parseEntryHead,
  playerContracts,
  parsePlayerReads,
  type EntryHead,
  type PlayerReads,
} from "./player";
import type { Phase } from "./round";
import type { SaltLookup } from "./saltStore";

const WHO = "0x48090D421F8B220431e46C6F05723C1C87710730" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const SALT = `0x${"11".repeat(32)}` as const;
const FLAT: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];
const PATH: Path = [
  { close: 10, high: 20, low: -5 },
  { close: 5, high: 30, low: -10 },
  { close: 0, high: 12, low: -12 },
];
const REAL: Path = [
  { close: 12, high: 25, low: -4 },
  { close: 8, high: 28, low: -8 },
  { close: 3, high: 15, low: -10 },
];
const ok = (v: unknown) => ({ status: "success", result: v });
const fail = { status: "failure", error: new Error("x") };

function reads(over: Partial<PlayerReads> = {}): PlayerReads {
  return {
    kind: 1,
    allowlisted: true,
    balance: 1000n,
    starterGrant: 1000n,
    entry: { kind: 0, revealed: false, hash: `0x${"00".repeat(32)}`, path: FLAT },
    claimed: false,
    rewardPerPoint: 1n,
    ...over,
  };
}

describe("parseEntryHead (entryOf is untrusted)", () => {
  it("accepts kind, revealed, hash and a valid path", () => {
    expect(parseEntryHead([1, true, HASH, PATH])).toEqual({ kind: 1, revealed: true, hash: HASH, path: PATH });
  });
  it("rejects malformed values", () => {
    expect(parseEntryHead(undefined)).toBeNull();
    expect(parseEntryHead([3, true, HASH, PATH])).toBeNull();
    expect(parseEntryHead([1, "yes", HASH, PATH])).toBeNull();
    expect(parseEntryHead([1, true, "0x12", PATH])).toBeNull();
    expect(parseEntryHead([1, true, HASH, [{ close: 0, high: -1, low: 0 }, ...FLAT.slice(1)]])).toBeNull();
  });
});

describe("parsePlayerReads", () => {
  const full = [ok(1), ok(true), ok(1000n), ok(1000n), ok([1, false, HASH, FLAT]), ok(false), ok(1n)];
  it("parses a complete multicall result", () => {
    expect(parsePlayerReads(full)).toEqual({
      kind: 1,
      allowlisted: true,
      balance: 1000n,
      starterGrant: 1000n,
      entry: { kind: 1, revealed: false, hash: HASH, path: FLAT },
      claimed: false,
      rewardPerPoint: 1n,
    });
  });
  it("needs kind and balance; the rest degrades (null means failed or malformed)", () => {
    expect(parsePlayerReads([fail, ...full.slice(1)])).toBeNull();
    expect(parsePlayerReads([full[0], full[1], fail, ...full.slice(3)])).toBeNull();
    expect(parsePlayerReads([ok(5), ...full.slice(1)])).toBeNull();
    expect(parsePlayerReads([ok(1), ok("true"), ...full.slice(2)])?.allowlisted).toBeNull();
    expect(parsePlayerReads([...full.slice(0, 4), fail, fail, fail])).toMatchObject({ entry: null, claimed: undefined, rewardPerPoint: undefined });
    expect(parsePlayerReads(undefined)).toBeNull();
    expect(parsePlayerReads(full.slice(0, 3))).toBeNull();
  });
  it("entry is undefined when there is no round to read", () => {
    expect(parsePlayerReads(full, false)?.entry).toBeUndefined();
    expect(parsePlayerReads(full, false)?.claimed).toBeUndefined();
  });
});

describe("playerContracts", () => {
  const A = {
    arena: "0x1111111111111111111111111111111111111111",
    registry: "0x2222222222222222222222222222222222222222",
    points: "0x3333333333333333333333333333333333333333",
    gate: "0x4444444444444444444444444444444444444444",
  } as const;
  it("is the multicall parsePlayerReads expects, in order, for the wallet and round", () => {
    const calls = playerContracts(A, 7n, WHO);
    expect(calls.map((c) => c.functionName)).toEqual(["kindOf", "isHuman", "balanceOf", "STARTER_GRANT", "entryOf", "isClaimed", "REWARD_PER_POINT"]);
    expect(calls.map((c) => c.address)).toEqual([A.registry, A.gate, A.points, A.registry, A.arena, A.arena, A.arena]);
    expect(calls.every((c) => c.chainId === 84532)).toBe(true);
    expect(calls[4]).toMatchObject({ args: [7n, WHO] });
    expect(calls[5]).toMatchObject({ args: [7n, WHO] });
    expect(playerContracts(A, undefined, WHO)[4]).toMatchObject({ args: [0n, WHO] });
  });
  it("every function exists in the shared ABI it is read from", () => {
    for (const c of playerContracts(A, 1n, WHO)) {
      expect(c.abi.some((x) => x.type === "function" && x.name === c.functionName)).toBe(true);
    }
  });
});

describe("deriveJoin", () => {
  const base = { configured: true, connected: true, reads: reads() as PlayerReads | null | undefined };
  it("walks through the unavailable states first", () => {
    expect(deriveJoin({ ...base, configured: false }).state).toBe("unconfigured");
    expect(deriveJoin({ ...base, connected: false }).state).toBe("no-wallet");
    expect(deriveJoin({ ...base, reads: undefined }).state).toBe("loading");
    expect(deriveJoin({ ...base, reads: null }).state).toBe("error");
  });
  it("a registered human shows the balance", () => {
    expect(deriveJoin(base)).toEqual({ state: "registered", balance: 1000n });
  });
  it("an agent wallet is not offered the human join", () => {
    expect(deriveJoin({ ...base, reads: reads({ kind: 2, balance: 900n }) })).toEqual({ state: "agent", balance: 900n });
  });
  it("an allowlisted unregistered wallet can join and sees the grant", () => {
    expect(deriveJoin({ ...base, reads: reads({ kind: 0, balance: 0n }) })).toEqual({ state: "can-join", grant: 1000n });
  });
  it("a wallet that is not allowlisted is told so plainly, a failed gate read is an error", () => {
    expect(deriveJoin({ ...base, reads: reads({ kind: 0, balance: 0n, allowlisted: false }) }).state).toBe("not-allowlisted");
    expect(deriveJoin({ ...base, reads: reads({ kind: 0, balance: 0n, allowlisted: null }) }).state).toBe("error");
  });
});

describe("commitPreflight", () => {
  const input = {
    phase: "commit" as Phase,
    closing: false,
    connected: true,
    correctChain: true,
    entryStake: 50n,
    reads: reads() as PlayerReads | null | undefined,
    path: PATH,
  };
  it("passes for a registered human with enough points in an open commit window", () => {
    expect(commitPreflight(input)).toEqual({ ok: true });
  });
  it("blocks with a reason, in a stable order", () => {
    const r = (o: Partial<typeof input>) => {
      const x = commitPreflight({ ...input, ...o });
      return x.ok ? "ok" : x.reason;
    };
    expect(r({ connected: false })).toMatch(/connect/i);
    expect(r({ correctChain: false })).toMatch(/Base Sepolia/);
    expect(r({ phase: "reveal" })).toMatch(/commit window/i);
    expect(r({ closing: true })).toMatch(/closing/i);
    expect(r({ path: [{ close: 0, high: -5, low: 0 }, ...PATH.slice(1)] as unknown as Path })).toMatch(/not valid/i);
    expect(r({ reads: undefined })).toMatch(/reading/i);
    expect(r({ reads: null })).toMatch(/could not read/i);
    expect(r({ reads: reads({ kind: 0 }) })).toMatch(/join as human/i);
    expect(r({ reads: reads({ kind: 2 }) })).toMatch(/agent/i);
    expect(r({ reads: reads({ entry: { kind: 1, revealed: false, hash: HASH, path: FLAT } }) })).toMatch(/already committed/i);
    expect(r({ reads: reads({ entry: null }) })).toMatch(/could not read/i);
    expect(r({ reads: reads({ entry: undefined }) })).toMatch(/could not read/i);
    expect(r({ reads: reads({ balance: 49n }) })).toMatch(/not enough points.*50.*49/i);
  });
  it("exactly the stake is enough", () => {
    expect(commitPreflight({ ...input, reads: reads({ balance: 50n }) })).toEqual({ ok: true });
  });
});

describe("deriveClaim (reward = (score - baseline) * REWARD_PER_POINT only above the baseline)", () => {
  const entry: EntryHead = { kind: 1, revealed: true, hash: HASH, path: PATH };
  const mine = score(PATH, REAL, 100);
  const base = { phase: "settled" as const, connected: true, entry, claimed: false, stake: 50n, rewardPerPoint: 1n, real: REAL, baseline: 0, T: 100 };

  it("is hidden before the round is final and without a wallet", () => {
    expect(deriveClaim({ ...base, phase: "market" }).state).toBe("hidden");
    expect(deriveClaim({ ...base, phase: "play" }).state).toBe("hidden");
    expect(deriveClaim({ ...base, connected: false }).state).toBe("no-wallet");
  });
  it("uses the shared score and pays stake plus the reward above the baseline", () => {
    const baseline = Math.max(0, mine - 7);
    const v = deriveClaim({ ...base, baseline, rewardPerPoint: 3n });
    expect(v).toEqual({
      state: "claimable",
      mode: "settled",
      stake: 50n,
      score: mine,
      baseline,
      rewardPerPoint: 3n,
      reward: BigInt(mine - baseline) * 3n,
      total: 50n + BigInt(mine - baseline) * 3n,
    });
  });
  it("pays no reward at or below the baseline (the stake still comes back)", () => {
    const eq = deriveClaim({ ...base, baseline: mine });
    expect(eq).toMatchObject({ state: "claimable", reward: 0n, total: 50n });
    if (mine < 100) expect(deriveClaim({ ...base, baseline: mine + 1 })).toMatchObject({ reward: 0n, total: 50n });
  });
  it("an unrevealed entry has nothing to claim in a settled round (its stake was burned at commit)", () => {
    expect(deriveClaim({ ...base, entry: { ...entry, revealed: false } }).state).toBe("unrevealed");
  });
  it("a void round refunds the stake, revealed or not, with no reward", () => {
    expect(deriveClaim({ ...base, phase: "void", entry: { ...entry, revealed: false } })).toEqual({ state: "claimable", mode: "void", stake: 50n, reward: 0n, total: 50n });
  });
  it("already claimed wins, no entry is reported, and loading or bad data is never a claimable state", () => {
    expect(deriveClaim({ ...base, claimed: true }).state).toBe("claimed");
    expect(deriveClaim({ ...base, entry: { ...entry, kind: 0 } }).state).toBe("no-entry");
    expect(deriveClaim({ ...base, entry: undefined }).state).toBe("loading");
    expect(deriveClaim({ ...base, claimed: undefined }).state).toBe("loading");
    expect(deriveClaim({ ...base, entry: null }).state).toBe("error");
    expect(deriveClaim({ ...base, baseline: undefined }).state).toBe("error");
    expect(deriveClaim({ ...base, real: undefined }).state).toBe("error");
    expect(deriveClaim({ ...base, rewardPerPoint: undefined }).state).toBe("error");
  });
});

describe("deriveEntry (what the entry panel shows and which actions exist)", () => {
  const good = commitHash(PATH, SALT, WHO);
  const found = (hash: `0x${string}` = good, relayAck = false): SaltLookup => ({
    state: "found",
    record: { version: 1, chainId: 84532, arena: WHO, id: 7n, who: WHO, path: PATH, salt: SALT, hash, status: "committed", createdAt: 1, ...(relayAck ? { relayAck } : {}) },
  });
  const committed: EntryHead = { kind: 1, revealed: false, hash: good, path: FLAT };
  const base = { connected: true, correctChain: true, phase: "reveal" as const, closing: false, entry: committed as EntryHead | null | undefined, lookup: found() as SaltLookup | undefined };

  it("no wallet, loading, error, no commit", () => {
    expect(deriveEntry({ ...base, connected: false }).stage).toBe("no-wallet");
    expect(deriveEntry({ ...base, entry: undefined }).stage).toBe("loading");
    expect(deriveEntry({ ...base, entry: null }).stage).toBe("error");
    expect(deriveEntry({ ...base, entry: { ...committed, kind: 0 } }).stage).toBe("none");
    expect(deriveEntry({ ...base, entry: { ...committed, kind: 2 } }).stage).toBe("agent");
  });
  it("revealed on chain is the only place that says the reveal landed", () => {
    const v = deriveEntry({ ...base, entry: { ...committed, revealed: true } });
    expect(v.stage).toBe("revealed");
    expect(v.canRelay).toBe(false);
    expect(v.canReveal).toBe(false);
  });
  it("during the reveal window a committed entry with its salt can be relayed and revealed by hand", () => {
    const v = deriveEntry(base);
    expect(v).toMatchObject({ stage: "committed", canRelay: true, canReveal: true });
  });
  it("during the commit window the relay can hold the path, but a manual reveal is not possible yet", () => {
    expect(deriveEntry({ ...base, phase: "commit" })).toMatchObject({ canRelay: true, canReveal: false });
  });
  it("in the last seconds of the reveal window nothing is offered (a transaction would land too late)", () => {
    expect(deriveEntry({ ...base, closing: true })).toMatchObject({ canRelay: false, canReveal: false });
  });
  it("a wrong chain or no wallet blocks the manual reveal, not the relay", () => {
    expect(deriveEntry({ ...base, correctChain: false })).toMatchObject({ canRelay: true, canReveal: false });
  });
  it("after the reveal window an unrevealed entry is forfeited (or refundable if the round is void)", () => {
    for (const phase of ["market", "play", "settled"] as const) {
      const v = deriveEntry({ ...base, phase });
      expect(v).toMatchObject({ canRelay: false, canReveal: false });
      expect(v.detail).toMatch(/forfeit|burned/i);
    }
    expect(deriveEntry({ ...base, phase: "void" }).detail).toMatch(/refund/i);
  });
  it("no saved salt in this browser means no reveal from here, and says so", () => {
    const v = deriveEntry({ ...base, lookup: { state: "none" } });
    expect(v).toMatchObject({ canRelay: false, canReveal: false });
    expect(v.detail).toMatch(/no saved|not saved|this browser/i);
  });
  it("a corrupt or non-matching record is never used", () => {
    expect(deriveEntry({ ...base, lookup: { state: "corrupt" } })).toMatchObject({ canRelay: false, canReveal: false });
    const mismatch = deriveEntry({ ...base, lookup: found(`0x${"99".repeat(32)}`) });
    expect(mismatch).toMatchObject({ canRelay: false, canReveal: false });
    expect(mismatch.detail).toMatch(/does not match|do not match/i);
  });
  it("waits for the saved record before offering anything", () => {
    expect(deriveEntry({ ...base, lookup: undefined })).toMatchObject({ canRelay: false, canReveal: false });
  });
});
