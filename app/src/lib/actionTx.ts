// Click paths for joining, committing, relaying, revealing and claiming, written against injected
// dependencies so they run without a chain or a wallet in tests. `useActions.ts` wires the real wagmi
// actions. The same rules as `marketTx.ts` apply:
//  - the wallet, the chain clock and the player state are read at click time, not taken from the last render;
//  - a transaction is never sent from a wallet on another chain;
//  - a hash that exists is never shown as "failed" unless the receipt says reverted (lookup error: unconfirmed);
//  - a pending transaction remembered in localStorage (per round and wallet) blocks a second send.
// Commit adds: the salt is saved (and read back) BEFORE the transaction is sent; a generated salt is never
// discarded (every attempt keeps its own record) and every later step picks the record by hash: the on-chain
// entry hash for the relay and the manual reveal, the sent transaction for the receipt. The path and salt go to
// the keeper relay only after the commit is confirmed (the relay verifies the commit on chain first).

import type { Address, Hash, Hex } from "viem";
import type { Path } from "../../../shared/score";
import { commitHash } from "./commitHash";
import type { InflightSlot, InflightStore } from "./inflight";
import { txErrorText } from "./market";
import { awaitReceipt, heldBy, type AccountNow, type ReceiptResult, type TxState } from "./marketTx";
import { commitPreflight, type EntryHead, type PlayerReads } from "./player";
import { NO_RELAY, type RelayOutcome, type RelayRequest } from "./relayClient";
import type { RoundView } from "./round";
import type { SaltRecord, SaltStore } from "./saltStore";

export type ChainCall = {
  contract: "arena" | "registry";
  functionName: "commit" | "reveal" | "claim" | "registerHuman";
  args: readonly unknown[];
  who: Address;
};

export type FreshPlayer = { round: RoundView | undefined; reads: PlayerReads | null };

export type ActionDeps = {
  chainId: number;
  /** Wallet account at click time (not the last render). */
  account(): AccountNow;
  /** The round (with the chain clock) and the player's reads, read now. `id` undefined reads no round. */
  readFresh(id: bigint | undefined, who: Address): Promise<FreshPlayer>;
  /** Dry run: throws the decoded revert. Returns the prepared request. */
  simulate(call: ChainCall): Promise<unknown>;
  write(request: unknown): Promise<Hash>;
  waitReceipt(hash: Hash): Promise<ReceiptResult>;
  inflight: InflightStore;
  salts: SaltStore;
  newSalt(): Hex;
  relay(req: RelayRequest): Promise<RelayOutcome>;
};

type SetTx = (s: TxState) => void;

export type RelayState =
  | { step: "idle" }
  | { step: "sending" }
  | { step: "blocked"; message: string }
  | { step: "done"; outcome: RelayOutcome };

type SetRelay = (s: RelayState) => void;

const UNREADABLE = "Could not read your account from Base Sepolia. Nothing was sent.";
const WRONG_CHAIN = "Your wallet is on another network. Switch to Base Sepolia (chain id 84532). Nothing was sent.";
const NO_WALLET = "Connect your wallet first. Nothing was sent.";

/** The connected address on the right chain, or null after reporting why not. */
function walletOn(deps: ActionDeps, setTx: SetTx): Address | null {
  const a = deps.account();
  if (!a.address || !a.isConnected) {
    setTx({ step: "failed", message: NO_WALLET });
    return null;
  }
  if (a.chainId !== deps.chainId) {
    setTx({ step: "failed", message: WRONG_CHAIN });
    return null;
  }
  return a.address;
}

export type Sent = "not-sent" | "confirmed" | "failed" | "unconfirmed";

/** Dry run, wallet signature, send, remember the hash, wait for the receipt. */
async function sendCall(
  deps: ActionDeps,
  p: { id: bigint | undefined; who: Address; slot: InflightSlot; label: string; call: ChainCall; onSent?: (hash: Hash) => void },
  setTx: SetTx,
): Promise<Sent> {
  let hash: Hash;
  try {
    setTx({ step: "checking", label: p.label });
    const request = await deps.simulate(p.call);
    setTx({ step: "signing", label: p.label });
    hash = await deps.write(request);
  } catch (e) {
    setTx({ step: "failed", message: txErrorText(e) });
    return "not-sent";
  }
  deps.inflight.set(p.id, p.who, p.slot, { action: `${p.call.contract}:${p.call.functionName}`, label: p.label, hash });
  p.onSent?.(hash);
  return awaitReceipt(deps, p.label, hash, setTx, () => deps.inflight.clear(p.id, p.who, p.slot));
}

async function readPlayer(deps: ActionDeps, id: bigint | undefined, who: Address, setTx: SetTx): Promise<FreshPlayer | null> {
  setTx({ step: "checking", label: "Checking your account" });
  try {
    const fresh = await deps.readFresh(id, who);
    if (fresh.reads === null) {
      setTx({ step: "failed", message: UNREADABLE });
      return null;
    }
    return fresh;
  } catch {
    setTx({ step: "failed", message: UNREADABLE });
    return null;
  }
}

const fail = (setTx: SetTx, message: string): void => setTx({ step: "failed", message });

// ---------------------------------------------------------------------------------------------- join

/** `Registry.registerHuman()`: mints the starter grant to an allowlisted wallet. */
export async function runJoin(deps: ActionDeps, setTx: SetTx): Promise<void> {
  const who = walletOn(deps, setTx);
  if (who === null) return;
  if (heldBy(deps, undefined, who, "join", setTx)) return;
  const fresh = await readPlayer(deps, undefined, who, setTx);
  if (fresh === null || fresh.reads === null) return;
  if (fresh.reads.kind !== 0) return fail(setTx, "This wallet is already registered.");
  if (fresh.reads.allowlisted === null) return fail(setTx, "Could not check the human allowlist. Nothing was sent.");
  if (!fresh.reads.allowlisted) return fail(setTx, "This wallet is not on the human allowlist, so it cannot join as a human. Nothing was sent.");
  await sendCall(deps, { id: undefined, who, slot: "join", label: "Join as human", call: { contract: "registry", functionName: "registerHuman", args: [], who } }, setTx);
}

// ---------------------------------------------------------------------------------------------- relay

const NO_SAVED = "No usable saved path for this round in this browser, so there is nothing to send.";

/** Posts one saved record to the relay and records the answer (on that record, by its hash). Never throws. */
async function postSaved(deps: ActionDeps, id: bigint, who: Address, rec: SaltRecord, setRelay: SetRelay): Promise<void> {
  setRelay({ step: "sending" });
  let outcome: RelayOutcome;
  try {
    outcome = await deps.relay({ id, who, path: rec.path, salt: rec.salt });
  } catch {
    outcome = { state: "unavailable", message: NO_RELAY };
  }
  if (outcome.state === "revealed" || outcome.state === "queued" || outcome.state === "pending") {
    deps.salts.patch(id, who, { hash: rec.hash }, { relayAck: true });
  }
  setRelay({ step: "done", outcome });
}

/** Button path: checks the chain first, then sends the saved path and salt to the relay again. */
export async function runRelay(deps: ActionDeps, i: { id: bigint }, setRelay: SetRelay): Promise<void> {
  const a = deps.account();
  if (!a.address || !a.isConnected) {
    setRelay({ step: "blocked", message: NO_WALLET });
    return;
  }
  const who = a.address;
  const blocked = (message: string): void => setRelay({ step: "blocked", message });
  setRelay({ step: "sending" });
  let fresh: FreshPlayer;
  try {
    fresh = await deps.readFresh(i.id, who);
  } catch {
    return blocked("Could not read the round from Base Sepolia. Nothing was sent.");
  }
  const phase = fresh.round?.status === "ready" ? fresh.round.phase : undefined;
  const entry = fresh.reads?.entry;
  if (phase === undefined || !fresh.reads || !entry) return blocked("Could not read your entry from Base Sepolia. Nothing was sent.");
  if (entry.kind !== 1) return blocked("This wallet has no human commit in this round.");
  if (entry.revealed) return blocked("Your entry is already revealed on-chain.");
  if (phase !== "commit" && !(phase === "reveal" && !fresh.round?.closing)) {
    return blocked("The reveal window is not open for the relay (it is over or about to close).");
  }
  // the record is chosen by the hash the chain holds, never "the latest one"
  const lookup = deps.salts.load(i.id, who, entry.hash);
  if (lookup.state !== "found") return blocked(NO_SAVED);
  if (lookup.record.hash.toLowerCase() !== entry.hash.toLowerCase()) {
    return blocked("The saved path and salt do not match the commit on chain, so they were not sent.");
  }
  await postSaved(deps, i.id, who, lookup.record, setRelay);
}

// ---------------------------------------------------------------------------------------------- commit

/** Commit click path: fresh read, preflight, save the salt, dry run, send, wait, then the relay. */
export async function runCommit(deps: ActionDeps, i: { id: bigint; path: Path }, setTx: SetTx, setRelay: SetRelay): Promise<void> {
  const who = walletOn(deps, setTx);
  if (who === null) return;
  if (heldBy(deps, i.id, who, "entry", setTx)) return;
  const fresh = await readPlayer(deps, i.id, who, setTx);
  if (fresh === null) return;
  const params = fresh.round?.status === "ready" ? fresh.round.params : undefined;
  if (fresh.round === undefined || fresh.round.phase === undefined || params === undefined) {
    return fail(setTx, "Could not read the round from Base Sepolia. Nothing was sent.");
  }
  const pre = commitPreflight({
    phase: fresh.round.phase,
    closing: fresh.round.closing,
    connected: true,
    correctChain: true,
    entryStake: params.entryStake,
    reads: fresh.reads,
    path: i.path,
  });
  if (!pre.ok) return fail(setTx, `${pre.reason} Nothing was sent.`);

  // The salt: written and read back BEFORE the transaction. Nothing saved is ever overwritten or dropped.
  const earlier = deps.salts.list(i.id, who);
  if (earlier.corrupt > 0) {
    return fail(setTx, "The path saved in this browser for this round is unreadable (damaged). It was left untouched and nothing was sent.");
  }
  // An earlier attempt whose transaction was sent may have reached the chain: do not start another one.
  if (earlier.records.some((r) => r.commitTx !== undefined || r.status !== "pending")) {
    return fail(
      setTx,
      "An earlier commit attempt for this round may have reached the chain, so its saved salt is kept and a new commit was not sent. Check your entry below.",
    );
  }
  let salt: Hex;
  let hash: Hex;
  try {
    salt = deps.newSalt();
    hash = commitHash(i.path, salt, who);
  } catch {
    return fail(setTx, "Could not create a random salt in this browser. Nothing was sent.");
  }
  const saved = deps.salts.save({ id: i.id, who, path: i.path, salt, hash });
  if (!saved.ok) {
    return fail(
      setTx,
      saved.reason === "exists"
        ? "An earlier commit attempt for this round may have reached the chain, so its saved salt is kept and a new commit was not sent. Check your entry below."
        : saved.reason === "storage"
          ? "Could not save your salt in this browser (storage is blocked or full), so the commit was not sent. Without the saved salt you could lose your stake. Nothing was sent."
          : "Could not prepare the commit. Nothing was sent.",
    );
  }

  // The record is patched by ITS hash, so a second attempt on the same wallet can never take it over.
  const sent: { tx?: Hash } = {};
  const result = await sendCall(
    deps,
    {
      id: i.id,
      who,
      slot: "entry",
      label: "Commit your path",
      call: { contract: "arena", functionName: "commit", args: [i.id, hash], who },
      onSent: (h) => {
        sent.tx = h;
        deps.salts.patch(i.id, who, { hash }, { status: "sent", commitTx: h });
      },
    },
    setTx,
  );
  if (sent.tx !== undefined) await afterCommit(deps, i.id, who, result, setRelay, sent.tx);
}

/**
 * What follows the receipt of the commit transaction `tx`, also when it was found after a reload (then only
 * the transaction is known). The record is the one that was sent in `tx`. Confirmed: it becomes "committed"
 * and its path goes to the relay. Mined and reverted, or replaced or cancelled in the wallet: this transaction
 * committed nothing, so the record goes back to "pending" (it is kept, never deleted) and the user can commit
 * again. A lookup error changes nothing.
 */
export async function afterCommit(deps: ActionDeps, id: bigint, who: Address, result: Sent, setRelay: SetRelay, tx: Hash): Promise<void> {
  if (result === "confirmed") {
    const rec = deps.salts.list(id, who).records.find((r) => r.commitTx?.toLowerCase() === tx.toLowerCase());
    if (rec === undefined) return setRelay({ step: "blocked", message: NO_SAVED });
    deps.salts.patch(id, who, { hash: rec.hash }, { status: "committed" });
    await postSaved(deps, id, who, rec, setRelay);
  } else if (result === "failed") {
    deps.salts.patch(id, who, { commitTx: tx }, { status: "pending", commitTx: null });
  }
}

// ---------------------------------------------------------------------------------------------- manual reveal

/** `Arena.reveal(id, who, path, salt)` with the saved record: the fallback when the relay is not used. */
export async function runManualReveal(deps: ActionDeps, i: { id: bigint }, setTx: SetTx): Promise<void> {
  const who = walletOn(deps, setTx);
  if (who === null) return;
  if (heldBy(deps, i.id, who, "entry", setTx)) return;
  const fresh = await readPlayer(deps, i.id, who, setTx);
  if (fresh === null || fresh.reads === null) return;
  const round = fresh.round;
  const entry: EntryHead | null | undefined = fresh.reads.entry;
  if (round?.status !== "ready" || round.phase === undefined || !entry) {
    return fail(setTx, "Could not read your entry from Base Sepolia. Nothing was sent.");
  }
  if (entry.kind === 0) return fail(setTx, "This wallet has no commit in this round. Nothing was sent.");
  if (entry.revealed) return fail(setTx, "Your entry is already revealed.");
  if (round.phase !== "reveal") return fail(setTx, "The reveal window is not open. Nothing was sent.");
  if (round.closing) return fail(setTx, "The reveal window is closing. A transaction would land too late. Nothing was sent.");
  const lookup = deps.salts.load(i.id, who, entry.hash);
  if (lookup.state !== "found") return fail(setTx, "No usable saved path for this round in this browser, so it cannot be revealed from here. Nothing was sent.");
  const rec = lookup.record;
  if (rec.hash.toLowerCase() !== entry.hash.toLowerCase()) {
    return fail(setTx, "The saved path and salt do not match the commit on chain, so they cannot be revealed. Nothing was sent.");
  }
  await sendCall(
    deps,
    { id: i.id, who, slot: "entry", label: "Reveal your path", call: { contract: "arena", functionName: "reveal", args: [i.id, who, rec.path, rec.salt], who } },
    setTx,
  );
}

// ---------------------------------------------------------------------------------------------- claim

/** `Arena.claim(id)`: the stake back plus the reward above the baseline (void round: the stake only). */
export async function runArenaClaim(deps: ActionDeps, i: { id: bigint }, setTx: SetTx): Promise<void> {
  const who = walletOn(deps, setTx);
  if (who === null) return;
  if (heldBy(deps, i.id, who, "arena-claim", setTx)) return;
  const fresh = await readPlayer(deps, i.id, who, setTx);
  if (fresh === null || fresh.reads === null) return;
  const phase = fresh.round?.status === "ready" ? fresh.round.phase : undefined;
  const entry = fresh.reads.entry;
  if (phase === undefined || !entry) return fail(setTx, "Could not read your entry from Base Sepolia. Nothing was sent.");
  if (phase !== "settled" && phase !== "void") return fail(setTx, "The round is not final yet, so there is nothing to claim.");
  if (entry.kind === 0) return fail(setTx, "This wallet has no entry in this round, so there is nothing to claim.");
  if (fresh.reads.claimed === undefined) return fail(setTx, "Could not read whether you already claimed. Nothing was sent.");
  if (fresh.reads.claimed) return fail(setTx, "You already claimed this round.");
  if (phase === "settled" && !entry.revealed) {
    return fail(setTx, "This entry was not revealed, so its stake was burned and there is nothing to claim.");
  }
  await sendCall(deps, { id: i.id, who, slot: "arena-claim", label: "Claim your points", call: { contract: "arena", functionName: "claim", args: [i.id], who } }, setTx);
}
