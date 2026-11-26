// The bet and claim click path, written against injected dependencies so it can be tested without a
// chain or a wallet. `useMarket.ts` wires the real wagmi actions.
//
// Invariant: once a transaction hash exists, nothing afterwards may show "failed" unless the receipt
// itself says reverted. A receipt lookup that errors (HTTP 429, timeout, transport) leaves the
// transaction possibly mined, so the state is "unconfirmed" and keeps the hash. The UI keeps the
// buttons disabled in that state, so the user cannot send a second bet on top of a pending one.

import type { Address, Hash } from "viem";
import type { InflightSlot, InflightStore } from "./inflight";
import {
  SIDE_CODE,
  betGuard,
  claimGuard,
  claimableAmount,
  remainingAllowance,
  txErrorText,
  viewOfData,
  winnerOf,
  type MarketData,
  type Side,
} from "./market";
import type { RoundView } from "./round";

export type TxState =
  | { step: "idle" }
  | { step: "checking" | "signing"; label: string }
  | { step: "pending"; label: string; hash: Hash }
  | { step: "unconfirmed"; label: string; hash: Hash; message: string }
  | { step: "confirmed"; label: string; hash: Hash }
  | { step: "failed"; message: string; hash?: Hash };

/** True while a transaction may still change the user's stake: the form and claim button stay disabled. */
export function isBusy(tx: TxState): boolean {
  return tx.step === "checking" || tx.step === "signing" || tx.step === "pending" || tx.step === "unconfirmed";
}

/**
 * The outcome of waiting for a receipt. `replaced`: the receipt belongs to another transaction (a speed up,
 * or a cancel or replacement sent from the wallet), so the transaction the app sent did not run as sent.
 */
export type ReceiptResult = { ok: boolean; replaced?: boolean };

/**
 * viem returns the REPLACEMENT's receipt when a wallet speeds up, cancels or replaces a transaction. Only the
 * receipt of the hash the app sent counts; any other hash is "replaced", whatever its status.
 */
export function receiptOutcome(sent: Hash, r: { status: string; transactionHash: Hash }): ReceiptResult {
  if (r.transactionHash.toLowerCase() !== sent.toLowerCase()) return { ok: false, replaced: true };
  return { ok: r.status === "success" };
}

export type FreshState = { round: RoundView; data: MarketData | null };
export type AccountNow = { address: Address | undefined; isConnected: boolean; chainId: number | undefined };

export type TxDeps = {
  /** Wallet account at click time (not the last render). */
  account(): AccountNow;
  /** Chain clock, round state and market state read at click time. */
  readFresh(id: bigint, who: Address): Promise<FreshState>;
  /** Dry run: throws the decoded revert. Returns the prepared request. */
  simulate(call: { functionName: "bet" | "claim"; args: readonly unknown[]; who: Address }): Promise<unknown>;
  write(request: unknown): Promise<Hash>;
  /** Resolves with the receipt outcome; rejects on any lookup error. */
  waitReceipt(hash: Hash): Promise<ReceiptResult>;
  chainId: number;
  /**
   * Remembers a sent transaction per (round, wallet) in localStorage, so a reload or a second tab cannot send
   * the same action again while it is pending. Optional (tests that do not care about persistence omit it).
   */
  inflight?: InflightStore;
};

type SetTx = (s: TxState) => void;

const UNREADABLE = "Could not read the market from Base Sepolia. Nothing was sent.";

/** Shown when the receipt is the one of a replacing transaction. */
export const REPLACED_MESSAGE =
  "The transaction was replaced in your wallet. Checking the chain for the result…";

/** Shown when this wallet already has a transaction in flight for the round (reload or second tab). */
export const HELD_MESSAGE =
  "A transaction from this wallet for this round was already sent and its result is not known yet. " +
  "Check it with the link and re-check below; nothing new was sent.";

/**
 * Waits for the receipt of a sent transaction. Never produces "failed" for a lookup error. `release` is called
 * only on a final answer (mined: confirmed or reverted), never when the lookup itself failed.
 */
export async function awaitReceipt(
  deps: Pick<TxDeps, "waitReceipt">,
  label: string,
  hash: Hash,
  setTx: SetTx,
  release?: () => void,
): Promise<"confirmed" | "failed" | "unconfirmed"> {
  setTx({ step: "pending", label, hash });
  try {
    const r = await deps.waitReceipt(hash);
    release?.();
    if (r.replaced) {
      setTx({ step: "failed", message: REPLACED_MESSAGE, hash });
      return "failed";
    }
    if (r.ok) {
      setTx({ step: "confirmed", label, hash });
      return "confirmed";
    }
    setTx({ step: "failed", message: "The transaction was mined but reverted.", hash });
    return "failed";
  } catch {
    setTx({
      step: "unconfirmed",
      label,
      hash,
      message:
        "The transaction was sent but its result could not be confirmed. It may still be mined. " +
        "Use the link to check it and re-check below; do not repeat the action until you know.",
    });
    return "unconfirmed";
  }
}

/** If this wallet has a pending transaction for the round, reports it and returns true (nothing may be sent). */
export function heldBy(deps: { inflight?: InflightStore }, id: bigint | undefined, who: Address, slot: InflightSlot, setTx: SetTx): boolean {
  const held = deps.inflight?.get(id, who, slot);
  if (!held) return false;
  setTx({ step: "unconfirmed", label: held.label, hash: held.hash, message: HELD_MESSAGE });
  return true;
}

/** Dry run, wallet signature, send. Returns the hash, or null after reporting a failure (nothing sent). */
async function sendTx(
  deps: TxDeps,
  label: string,
  call: { functionName: "bet" | "claim"; args: readonly unknown[]; who: Address },
  setTx: SetTx,
): Promise<Hash | null> {
  try {
    setTx({ step: "checking", label });
    const request = await deps.simulate(call);
    setTx({ step: "signing", label });
    const hash = await deps.write(request);
    deps.inflight?.set(call.args[0] as bigint, call.who, "market", { action: `market:${call.functionName}`, label, hash });
    return hash;
  } catch (e) {
    setTx({ step: "failed", message: txErrorText(e) });
    return null;
  }
}

export type BetInput = { id: bigint; side: Side; amountText: string };

/** Bet click path: fresh read, guard, dry run, send, wait. */
export async function runBet(deps: TxDeps, i: BetInput, setTx: SetTx): Promise<void> {
  const acct = deps.account();
  if (!acct.address) return;
  if (heldBy(deps, i.id, acct.address, "market", setTx)) return;
  setTx({ step: "checking", label: "Checking the market" });
  let fresh: FreshState;
  try {
    fresh = await deps.readFresh(i.id, acct.address);
  } catch {
    setTx({ step: "failed", message: UNREADABLE });
    return;
  }
  if (fresh.round.status !== "ready" || !fresh.round.phase || fresh.data === null) {
    setTx({ step: "failed", message: UNREADABLE });
    return;
  }
  const view = viewOfData(fresh.round.phase, fresh.data);
  const guard = betGuard({
    state: view.state,
    closing: fresh.round.closing,
    connected: acct.isConnected,
    correctChain: acct.chainId === deps.chainId,
    balance: fresh.data.balance,
    remaining: remainingAllowance(fresh.data.cap, fresh.data.stake.human, fresh.data.stake.agent),
    amountText: i.amountText,
  });
  if (!guard.ok) {
    setTx({ step: "failed", message: guard.reason });
    return;
  }
  const label = `Bet ${guard.amount} points on ${i.side}`;
  const hash = await sendTx(
    deps,
    label,
    { functionName: "bet", args: [i.id, SIDE_CODE[i.side], guard.amount], who: acct.address },
    setTx,
  );
  const who = acct.address;
  if (hash !== null) await awaitReceipt(deps, label, hash, setTx, () => deps.inflight?.clear(i.id, who, "market"));
}

/** Claim click path: fresh read, guard, dry run, send, wait. */
export async function runClaim(deps: TxDeps, i: { id: bigint }, setTx: SetTx): Promise<void> {
  const acct = deps.account();
  if (!acct.address) return;
  if (heldBy(deps, i.id, acct.address, "market", setTx)) return;
  setTx({ step: "checking", label: "Checking the market" });
  let fresh: FreshState;
  try {
    fresh = await deps.readFresh(i.id, acct.address);
  } catch {
    setTx({ step: "failed", message: UNREADABLE });
    return;
  }
  if (fresh.round.status !== "ready" || !fresh.round.phase || fresh.data === null) {
    setTx({ step: "failed", message: UNREADABLE });
    return;
  }
  const view = viewOfData(fresh.round.phase, fresh.data);
  const winner = winnerOf(fresh.data.scores);
  const guard = claimGuard({
    state: view.state,
    connected: acct.isConnected,
    correctChain: acct.chainId === deps.chainId,
    claimed: fresh.data.claimed,
    resultKnown: view.state !== "resolved" || winner !== undefined,
    amount: claimableAmount({ state: view.state, winner, stake: fresh.data.stake, pools: fresh.data.pools }),
  });
  if (!guard.ok) {
    setTx({ step: "failed", message: guard.reason });
    return;
  }
  const hash = await sendTx(deps, "Claim", { functionName: "claim", args: [i.id], who: acct.address }, setTx);
  const who = acct.address;
  if (hash !== null) await awaitReceipt(deps, "Claim", hash, setTx, () => deps.inflight?.clear(i.id, who, "market"));
}
