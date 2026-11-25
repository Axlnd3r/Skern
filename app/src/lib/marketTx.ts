// The bet and claim click path, written against injected dependencies so it can be tested without a
// chain or a wallet. `useMarket.ts` wires the real wagmi actions.
//
// Invariant: once a transaction hash exists, nothing afterwards may show "failed" unless the receipt
// itself says reverted. A receipt lookup that errors (HTTP 429, timeout, transport) leaves the
// transaction possibly mined, so the state is "unconfirmed" and keeps the hash. The UI keeps the
// buttons disabled in that state, so the user cannot send a second bet on top of a pending one.

import type { Address, Hash } from "viem";
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
  waitReceipt(hash: Hash): Promise<{ ok: boolean }>;
  chainId: number;
};

type SetTx = (s: TxState) => void;

const UNREADABLE = "Could not read the market from Base Sepolia. Nothing was sent.";

/** Waits for the receipt of a sent transaction. Never produces "failed" for a lookup error. */
export async function awaitReceipt(deps: TxDeps, label: string, hash: Hash, setTx: SetTx): Promise<void> {
  setTx({ step: "pending", label, hash });
  try {
    const r = await deps.waitReceipt(hash);
    if (r.ok) setTx({ step: "confirmed", label, hash });
    else setTx({ step: "failed", message: "The transaction was mined but reverted.", hash });
  } catch {
    setTx({
      step: "unconfirmed",
      label,
      hash,
      message:
        "The transaction was sent but its result could not be confirmed. It may still be mined. " +
        "Use the link to check it and re-check below; do not repeat the action until you know.",
    });
  }
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
    return await deps.write(request);
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
  if (hash !== null) await awaitReceipt(deps, label, hash, setTx);
}

/** Claim click path: fresh read, guard, dry run, send, wait. */
export async function runClaim(deps: TxDeps, i: { id: bigint }, setTx: SetTx): Promise<void> {
  const acct = deps.account();
  if (!acct.address) return;
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
  if (hash !== null) await awaitReceipt(deps, "Claim", hash, setTx);
}
