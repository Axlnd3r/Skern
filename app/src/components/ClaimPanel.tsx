"use client";

import { claimGuard, claimableAmount, viewOfData, winnerOf, type MarketData } from "@/lib/market";
import { isBusy, type TxState } from "@/lib/marketTx";
import { deriveClaim, type ClaimView } from "@/lib/player";
import type { RevealReads } from "@/lib/reveal";
import type { Phase } from "@/lib/round";
import { useArenaClaimAction, usePlayer } from "@/lib/useActions";
import { useMarketActions, useMarketReads } from "@/lib/useMarket";
import { useAccount } from "wagmi";
import { TxStatus } from "./MarketPanel";

export type ArenaClaimViewProps = {
  view: ClaimView;
  correctChain: boolean;
  tx: TxState;
  onClaim: () => void;
  onRecheck: () => void;
};

/** Claim of the player's own entry: `Arena.claim(id)`. The numbers are the contract's; see `deriveClaim`. */
export function ArenaClaimView({ view, correctChain, tx, onClaim, onRecheck }: ArenaClaimViewProps) {
  if (view.state === "hidden") return null;
  const busy = isBusy(tx);
  return (
    <section className="card claim" aria-label="Claim your points" aria-live="polite" data-claim-state={view.state}>
      <h2>Claim your points</h2>
      {view.state === "no-wallet" ? <p className="muted">Connect your wallet to see and claim your points.</p> : null}
      {view.state === "loading" ? <p className="muted">Reading your entry...</p> : null}
      {view.state === "error" ? <p className="error">Could not read your entry from Base Sepolia, so nothing can be claimed from here.</p> : null}
      {view.state === "no-entry" ? <p className="muted">Your wallet has no entry in this round, so there is nothing to claim.</p> : null}
      {view.state === "unrevealed" ? (
        <p className="muted">
          Your entry was not revealed in time. Its stake was burned when you committed, so there is nothing to claim.
        </p>
      ) : null}
      {view.state === "claimed" ? <p className="ok" data-claimed>Already claimed. The points are in your wallet balance.</p> : null}
      {view.state === "claimable" && view.mode === "void" ? (
        <p>
          This round is void (it did not settle). You can claim your entry stake back:{" "}
          <strong data-claim-total={view.total.toString()}>{view.total.toString()}</strong> points.
        </p>
      ) : null}
      {view.state === "claimable" && view.mode === "settled" ? (
        <>
          <p>
            Your score {view.score}, flat-path baseline {view.baseline}.{" "}
            {view.reward > 0n ? (
              <>
                Reward: ({view.score} - {view.baseline}) x {view.rewardPerPoint.toString()} ={" "}
                <strong data-claim-reward={view.reward.toString()}>{view.reward.toString()}</strong> points.
              </>
            ) : (
              <span data-claim-reward="0">No reward: your score is not above the baseline.</span>
            )}
          </p>
          <p>
            You get your {view.stake.toString()} stake back plus the reward:{" "}
            <strong data-claim-total={view.total.toString()}>{view.total.toString()}</strong> points.
          </p>
        </>
      ) : null}
      {view.state === "claimable" ? (
        <>
          <button type="button" className="btn primary" data-claim-submit disabled={busy || !correctChain} onClick={onClaim}>
            {busy ? "Working..." : `Claim ${view.total.toString()} points`}
          </button>
          {!correctChain ? <p className="hint">Switch your wallet to Base Sepolia to claim.</p> : null}
        </>
      ) : null}
      <TxStatus tx={tx} onRecheck={onRecheck} />
    </section>
  );
}

/** Wires the wallet's entry, the round numbers and the claim transaction into the tested view. */
export function ArenaClaim(props: {
  roundId: bigint;
  phase: Phase;
  T: number;
  entryStake: bigint;
  reads: RevealReads | undefined;
}) {
  const live = props.phase === "settled" || props.phase === "void";
  const player = usePlayer(live ? props.roundId : undefined);
  const claim = useArenaClaimAction(props.roundId, player.address, player.refetch);
  const r = player.reads;
  const view = deriveClaim({
    phase: props.phase,
    connected: player.connected,
    entry: r === undefined || r === null ? (r as null | undefined) : r.entry,
    claimed: r ? r.claimed : undefined,
    stake: props.entryStake,
    rewardPerPoint: r ? r.rewardPerPoint : undefined,
    real: props.reads?.real,
    baseline: props.reads?.baseline,
    T: props.T,
  });
  return (
    <ArenaClaimView
      view={view}
      correctChain={player.correctChain}
      tx={claim.tx}
      onClaim={() => void claim.claim()}
      onRecheck={() => void claim.recheck()}
    />
  );
}

// ---------------------------------------------------------------------------------------------- market

export type MarketClaimViewProps = {
  data: MarketData;
  phase: Phase;
  connected: boolean;
  correctChain: boolean;
  tx: TxState;
  onClaim: () => void;
  onRecheck: () => void;
};

/** Claim of a market bet: `GapMarket.claim(id)`. Hidden until the market is final; same rules as the market screen. */
export function MarketClaimView(props: MarketClaimViewProps) {
  const { data, phase, tx } = props;
  const view = viewOfData(phase, data);
  const final = view.state === "cancelled" || view.state === "tie" || view.state === "resolved";
  if (!final) return null;
  const winner = winnerOf(data.scores);
  const resultKnown = view.state !== "resolved" || winner !== undefined;
  const amount = claimableAmount({ state: view.state, winner, stake: data.stake, pools: data.pools });
  const guard = claimGuard({
    state: view.state,
    connected: props.connected,
    correctChain: props.correctChain,
    claimed: data.claimed,
    resultKnown,
    amount,
  });
  const staked = data.stake.human + data.stake.agent;
  const busy = isBusy(tx);
  return (
    <section className="card claim" aria-label="Claim your market winnings" aria-live="polite" data-market-claim>
      <h2>Market: claim</h2>
      <p className="muted">{view.headline}</p>
      {!resultKnown ? (
        <p className="muted">Reading the result of the market...</p>
      ) : staked === 0n ? (
        <p className="muted">You placed no bet in this round&apos;s market, so there is nothing to claim.</p>
      ) : (
        <p>
          Your claim: <strong data-market-claim-amount={amount.toString()}>{amount.toString()}</strong> points
          {view.state === "resolved" && amount === 0n ? " (your side did not win)" : ""}
        </p>
      )}
      {data.claimed ? <p className="ok">Already claimed.</p> : null}
      {staked > 0n ? (
        <button type="button" className="btn primary" data-market-claim-submit disabled={!guard.ok || busy} onClick={props.onClaim}>
          {busy ? "Working..." : view.state === "resolved" ? "Claim winnings" : "Claim refund"}
        </button>
      ) : null}
      {staked > 0n && !guard.ok && !data.claimed && resultKnown ? <p className="hint">{guard.reason}</p> : null}
      <TxStatus tx={tx} onRecheck={props.onRecheck} />
    </section>
  );
}

/** Wires the market reads and the claim transaction into the tested view. */
export function MarketClaim(props: { roundId: bigint; phase: Phase }) {
  const { address, isConnected } = useAccount();
  const reads = useMarketReads(props.roundId, address);
  const actions = useMarketActions(props.roundId, reads.refetch);
  if (reads.status !== "ready" || reads.data === undefined) return null;
  return (
    <MarketClaimView
      data={reads.data}
      phase={props.phase}
      connected={isConnected && address !== undefined}
      correctChain={actions.correctChain}
      tx={actions.tx}
      onClaim={() => void actions.claim()}
      onRecheck={() => void actions.recheck()}
    />
  );
}
