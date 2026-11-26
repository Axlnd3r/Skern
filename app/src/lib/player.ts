// Pure logic for the connected player: registration (join), the commit preconditions, the entry panel
// (relay and manual reveal) and the Arena claim. Everything read from the chain is untrusted and validated
// first. The reward numbers come from the contract (`entryStake`, `baselineScore`, `REWARD_PER_POINT`);
// the player's own score is computed with `shared/score.ts`, never re-implemented here.

import { isValid, score, type Path } from "../../../shared/score";
import type { Hex } from "viem";
import type { Address } from "viem";
import { allowlistGateAbi, arenaAbi, BASE_SEPOLIA_CHAIN_ID, pointsAbi, registryAbi } from "./chain";
import { isBig, parsePath, successOf } from "./chainData";
import type { Phase } from "./round";
import type { SaltLookup } from "./saltStore";

/** `Registry.Kind`: 0 none, 1 human, 2 agent. */
export type Kind = 0 | 1 | 2;

/** `Arena.entryOf` result: kind, revealed, commit hash, revealed path (all zero until revealed). */
export type EntryHead = { kind: Kind; revealed: boolean; hash: Hex; path: Path };

export function parseEntryHead(raw: unknown): EntryHead | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [kind, revealed, hash, path] = raw as unknown[];
  if (kind !== 0 && kind !== 1 && kind !== 2) return null;
  if (typeof revealed !== "boolean") return null;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const p = parsePath(path);
  if (p === null) return null;
  return { kind, revealed, hash: hash as Hex, path: p };
}

export type PlayerReads = {
  kind: Kind;
  /** `AllowlistGate.isHuman`; null when that read failed or was malformed. */
  allowlisted: boolean | null;
  /** `Points.balanceOf`. */
  balance: bigint;
  /** `Registry.STARTER_GRANT`; null when unreadable. */
  starterGrant: bigint | null;
  /** The wallet's entry in the round: undefined when there is no round, null when unreadable. */
  entry: EntryHead | null | undefined;
  claimed: boolean | undefined;
  rewardPerPoint: bigint | undefined;
};

export const PLAYER_READ_COUNT = 7;

export type PlayerAddresses = { arena: Address; registry: Address; points: Address; gate: Address };

/**
 * The multicall behind `parsePlayerReads` (same order). `id` undefined reads no round: the two round calls
 * are sent with round 0 (they fail and are ignored). `who` is the connected wallet.
 */
export function playerContracts(a: PlayerAddresses, id: bigint | undefined, who: Address) {
  const chainId = BASE_SEPOLIA_CHAIN_ID;
  const rid = id ?? 0n;
  return [
    { address: a.registry, abi: registryAbi, functionName: "kindOf", args: [who], chainId },
    { address: a.gate, abi: allowlistGateAbi, functionName: "isHuman", args: [who], chainId },
    { address: a.points, abi: pointsAbi, functionName: "balanceOf", args: [who], chainId },
    { address: a.registry, abi: registryAbi, functionName: "STARTER_GRANT", chainId },
    { address: a.arena, abi: arenaAbi, functionName: "entryOf", args: [rid, who], chainId },
    { address: a.arena, abi: arenaAbi, functionName: "isClaimed", args: [rid, who], chainId },
    { address: a.arena, abi: arenaAbi, functionName: "REWARD_PER_POINT", chainId },
  ] as const;
}

/**
 * Validates the player multicall (`allowFailure`): [Registry.kindOf, AllowlistGate.isHuman, Points.balanceOf,
 * Registry.STARTER_GRANT, Arena.entryOf, Arena.isClaimed, Arena.REWARD_PER_POINT]. `kind` and `balance` are
 * essential (null otherwise); everything else degrades. With `hasRound` false the round reads are ignored.
 */
export function parsePlayerReads(results: readonly unknown[] | undefined, hasRound = true): PlayerReads | null {
  if (!results || results.length !== PLAYER_READ_COUNT) return null;
  const val = (i: number): { result: unknown } | null => successOf(results[i]);
  const k = val(0);
  const b = val(2);
  if (k === null || b === null) return null;
  if (k.result !== 0 && k.result !== 1 && k.result !== 2) return null;
  if (!isBig(b.result)) return null;
  const gate = val(1);
  const grant = val(3);
  const entryS = val(4);
  const claimedS = val(5);
  const rppS = val(6);
  return {
    kind: k.result,
    allowlisted: gate !== null && typeof gate.result === "boolean" ? gate.result : null,
    balance: b.result,
    starterGrant: grant !== null && isBig(grant.result) ? grant.result : null,
    entry: hasRound ? (entryS === null ? null : parseEntryHead(entryS.result)) : undefined,
    claimed: hasRound && claimedS !== null && typeof claimedS.result === "boolean" ? claimedS.result : undefined,
    rewardPerPoint: rppS !== null && isBig(rppS.result) ? rppS.result : undefined,
  };
}

// ---------------------------------------------------------------------------------------------- join

export type JoinState =
  | { state: "unconfigured" | "no-wallet" | "loading" | "error" | "not-allowlisted" }
  | { state: "registered"; balance: bigint }
  | { state: "agent"; balance: bigint }
  | { state: "can-join"; grant: bigint | null };

export function deriveJoin(i: { configured: boolean; connected: boolean; reads: PlayerReads | null | undefined }): JoinState {
  if (!i.configured) return { state: "unconfigured" };
  if (!i.connected) return { state: "no-wallet" };
  if (i.reads === undefined) return { state: "loading" };
  if (i.reads === null) return { state: "error" };
  if (i.reads.kind === 1) return { state: "registered", balance: i.reads.balance };
  if (i.reads.kind === 2) return { state: "agent", balance: i.reads.balance };
  if (i.reads.allowlisted === null) return { state: "error" };
  if (!i.reads.allowlisted) return { state: "not-allowlisted" };
  return { state: "can-join", grant: i.reads.starterGrant };
}

// ---------------------------------------------------------------------------------------------- commit

export type Preflight = { ok: true } | { ok: false; reason: string };

/**
 * Everything that must hold before a commit is sent, in the order the user can fix it. Used for the button
 * (from the last render) and again at click time with freshly read values.
 */
export function commitPreflight(i: {
  phase: Phase;
  closing: boolean;
  connected: boolean;
  correctChain: boolean;
  entryStake: bigint;
  reads: PlayerReads | null | undefined;
  path: Path;
}): Preflight {
  const no = (reason: string): Preflight => ({ ok: false, reason });
  if (!i.connected) return no("Connect your wallet to commit.");
  if (!i.correctChain) return no("Switch your wallet to Base Sepolia (chain id 84532) to commit.");
  if (i.phase !== "commit") return no("The commit window is not open.");
  if (i.closing) return no("The commit window is closing. A transaction would land too late.");
  if (!isValid(i.path)) return no("The path is not valid.");
  if (i.reads === undefined) return no("Reading your account...");
  if (i.reads === null) return no("Could not read your account from Base Sepolia.");
  if (i.reads.kind === 0) return no("Join as human first: this wallet is not registered.");
  if (i.reads.kind === 2) return no("This wallet is registered as an agent. Agents commit with their own SDK, not from this screen.");
  if (i.reads.entry === undefined || i.reads.entry === null) return no("Could not read your entry for this round from Base Sepolia.");
  if (i.reads.entry.kind !== 0) return no("This wallet has already committed in this round.");
  if (i.reads.balance < i.entryStake) {
    return no(`Not enough points: this round's entry stake is ${i.entryStake.toString()} and you have ${i.reads.balance.toString()}.`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- entry panel

export type EntryStage = "no-wallet" | "loading" | "error" | "none" | "agent" | "committed" | "revealed";

export type EntryView = {
  stage: EntryStage;
  headline: string;
  detail: string;
  /** Send the saved path and salt to the keeper relay (allowed in the commit and reveal windows). */
  canRelay: boolean;
  /** Reveal with a wallet transaction (reveal window only). */
  canReveal: boolean;
};

/**
 * The state of the player's own entry, from the chain (`entry`) and the saved salt (`lookup`). "Revealed"
 * is claimed only when the chain says so. A saved record is used only if its hash equals the on-chain hash.
 */
export function deriveEntry(i: {
  connected: boolean;
  correctChain: boolean;
  phase: Phase;
  closing: boolean;
  entry: EntryHead | null | undefined;
  lookup: SaltLookup | undefined;
}): EntryView {
  const v = (stage: EntryStage, headline: string, detail = "", canRelay = false, canReveal = false): EntryView => ({
    stage,
    headline,
    detail,
    canRelay,
    canReveal,
  });
  if (!i.connected) return v("no-wallet", "Connect a wallet to see your entry.");
  if (i.entry === undefined) return v("loading", "Reading your entry...");
  if (i.entry === null) return v("error", "Could not read your entry from Base Sepolia.");
  if (i.entry.kind === 0) return v("none", "No entry from this wallet in this round.");
  if (i.entry.kind === 2) return v("agent", "This wallet is registered as an agent.", "Agents reveal with their own SDK.");
  if (i.entry.revealed) {
    return v("revealed", "Revealed on-chain. Your path counts toward the Human consensus.", "Nothing more to do until the round settles.");
  }

  const lost = (detail: string) => v("committed", "Committed on-chain, not revealed yet.", detail);
  const reveal = i.phase === "reveal";
  const open = i.phase === "commit" || reveal;
  if (!open) {
    return i.phase === "void"
      ? v("committed", "Committed, not revealed. This round is void.", "The round did not settle: your entry stake is refundable with the Claim button on the Reveal screen.")
      : v("committed", "Not revealed in time.", "The reveal window is over, so this entry is forfeited: its stake was burned at commit and it has no score.");
  }
  if (i.lookup === undefined) return lost("Looking for your saved path...");
  if (i.lookup.state === "corrupt") {
    return lost("The path saved in this browser is damaged and was not used. It cannot be revealed from here; the saved data was left untouched.");
  }
  if (i.lookup.state === "none") {
    return lost("This browser has no saved path for this round (it was committed from another browser or the saved data was cleared), so it cannot be revealed from here.");
  }
  if (i.lookup.record.hash.toLowerCase() !== i.entry.hash.toLowerCase()) {
    return lost("The saved path and salt do not match the commit on chain, so they cannot be revealed.");
  }
  const late = reveal && i.closing;
  const canRelay = !late;
  const canReveal = reveal && !late && i.correctChain;
  const detail = late
    ? "The reveal window is closing. A transaction would land too late."
    : reveal
      ? "The reveal window is open. The relay can reveal for you, or you can reveal yourself below."
      : "The relay will reveal your saved path when the reveal window opens. Keep this browser's saved data until then.";
  return v("committed", "Committed on-chain, not revealed yet.", detail, canRelay, canReveal);
}

// ---------------------------------------------------------------------------------------------- claim

export type ClaimView =
  | { state: "hidden" | "no-wallet" | "loading" | "error" | "no-entry" | "unrevealed" | "claimed" }
  | { state: "claimable"; mode: "void"; stake: bigint; reward: 0n; total: bigint }
  | { state: "claimable"; mode: "settled"; stake: bigint; score: number; baseline: number; rewardPerPoint: bigint; reward: bigint; total: bigint };

/**
 * What `Arena.claim(id)` will pay the wallet. Void round: the stake back, nothing else. Settled round: a
 * revealed entry gets the stake plus `(score - baseline) * REWARD_PER_POINT` when its score is strictly
 * above the baseline; an unrevealed entry cannot claim (its stake was burned at commit).
 */
export function deriveClaim(i: {
  phase: Phase;
  connected: boolean;
  entry: EntryHead | null | undefined;
  claimed: boolean | undefined;
  stake: bigint;
  rewardPerPoint: bigint | undefined;
  real: Path | undefined;
  baseline: number | undefined;
  T: number;
}): ClaimView {
  if (i.phase !== "settled" && i.phase !== "void") return { state: "hidden" };
  if (!i.connected) return { state: "no-wallet" };
  if (i.entry === null) return { state: "error" };
  if (i.entry === undefined || i.claimed === undefined) return { state: "loading" };
  if (i.entry.kind === 0) return { state: "no-entry" };
  if (i.claimed) return { state: "claimed" };
  if (i.phase === "void") return { state: "claimable", mode: "void", stake: i.stake, reward: 0n, total: i.stake };
  if (!i.entry.revealed) return { state: "unrevealed" };
  if (i.rewardPerPoint === undefined || i.baseline === undefined || i.real === undefined) return { state: "error" };
  let mine: number;
  try {
    mine = score(i.entry.path, i.real, i.T);
  } catch {
    return { state: "error" };
  }
  const reward = mine > i.baseline ? BigInt(mine - i.baseline) * i.rewardPerPoint : 0n;
  return { state: "claimable", mode: "settled", stake: i.stake, score: mine, baseline: i.baseline, rewardPerPoint: i.rewardPerPoint, reward, total: i.stake + reward };
}
