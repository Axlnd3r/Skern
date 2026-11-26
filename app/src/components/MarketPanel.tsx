"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import {
  SIDE_CODE,
  betGuard,
  claimGuard,
  claimableAmount,
  quorumOf,
  remainingAllowance,
  viewOfData,
  winnerOf,
  type MarketData,
  type Side,
} from "@/lib/market";
import { impliedOdds, projectedPayout } from "@/lib/odds";
import { fitBound } from "@/lib/reveal";
import type { Phase } from "@/lib/round";
import { isBusy, type TxState } from "@/lib/marketTx";
import { useMarketActions, useMarketReads } from "@/lib/useMarket";
import { Arrow } from "./doodle";
import { Annotation } from "./doodle/Annotation";
import { PathChart, SERIES_COLOR, type ChartSeries } from "./PathChart";

const pct = (x: number) => Math.round(x * 100);

export type MarketPanelViewProps = {
  roundId: bigint;
  /** Round tolerance in bp (only scales the overlay axis). */
  T: number;
  phase: Phase;
  /** `closing` from useRound: the last seconds of the window. Betting is disabled then. */
  closing: boolean;
  data: MarketData;
  /** The last refresh failed; `data` is the last good read. */
  stale: boolean;
  connected: boolean;
  correctChain: boolean;
  tx: TxState;
  onBet: (side: Side, amountText: string) => void;
  onClaim: () => void;
  /** Looks the receipt of an unconfirmed transaction up again. */
  onRecheck: () => void;
};

/**
 * Presentational market panel: everything shown comes from validated `MarketData` and the pure
 * functions in `@/lib/market` and `@/lib/odds`. It holds only the form inputs.
 */
export function MarketPanelView(props: MarketPanelViewProps) {
  const { data, phase, closing, tx } = props;
  const [side, setSide] = useState<Side>("human");
  const [amountText, setAmountText] = useState("10");

  const view = viewOfData(phase, data);
  const quorum = quorumOf(data.reveals.human, data.reveals.agent, data.minReveals);
  const odds = impliedOdds(data.pools.human, data.pools.agent);
  const total = data.pools.human + data.pools.agent;
  const remaining = remainingAllowance(data.cap, data.stake.human, data.stake.agent);
  const busy = isBusy(tx);

  const guard = betGuard({
    state: view.state,
    closing,
    connected: props.connected,
    correctChain: props.correctChain,
    balance: data.balance,
    remaining,
    amountText,
  });
  const winner = winnerOf(data.scores);
  const resultKnown = view.state !== "resolved" || winner !== undefined;
  const claimAmount = claimableAmount({ state: view.state, winner, stake: data.stake, pools: data.pools });
  const claim = claimGuard({
    state: view.state,
    connected: props.connected,
    correctChain: props.correctChain,
    claimed: data.claimed,
    resultKnown,
    amount: claimAmount,
  });

  // The overlay draws a consensus path only when the contract says it is frozen (`ready`).
  const humanPath = data.consensus.human.ready ? data.consensus.human.path : null;
  const agentPath = data.consensus.agent.ready ? data.consensus.agent.path : null;
  const series: ChartSeries[] = [
    ...(humanPath ? [{ id: "human", label: "Human consensus", color: SERIES_COLOR.human, filled: false, offset: -16, candles: humanPath }] : []),
    ...(agentPath ? [{ id: "agent", label: "Agent consensus", color: SERIES_COLOR.agent, filled: false, offset: 16, candles: agentPath }] : []),
  ];
  const final = view.state === "cancelled" || view.state === "tie" || view.state === "resolved";
  const payout = guard.ok ? projectedPayout(guard.amount, data.pools[side], total) : null;

  return (
    <div className="market">
      <h3 aria-live="polite">{view.headline}</h3>
      <p className="muted">{view.detail}</p>
      <p className="muted">Points only: testnet points have no cash value and nothing here is real-money betting.</p>
      {props.stale ? <p className="error">Could not refresh from Base Sepolia; showing the last data read.</p> : null}

      <table className="values" aria-label="Quorum">
        <tbody>
          <tr>
            <td>Human reveals</td>
            <td>
              {data.reveals.human.toString()} of {data.minReveals.toString()} needed
            </td>
          </tr>
          <tr>
            <td>Agent reveals</td>
            <td>
              {data.reveals.agent.toString()} of {data.minReveals.toString()} needed
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted">{quorum.met ? "Quorum reached." : "Quorum not reached: the market opens only if each side has enough reveals."}</p>

      <div className="pools" aria-label="Pools and implied odds">
        <div>
          <span className="tag-side human">Human wins</span>
          <p>
            Pool <strong data-pool-human={data.pools.human.toString()}>{data.pools.human.toString()}</strong> points
          </p>
          <p>
            Implied <strong data-odds-human={pct(odds.human)}>{pct(odds.human)}%</strong>
          </p>
        </div>
        <div>
          <span className="tag-side agent">Agent wins</span>
          <p>
            Pool <strong data-pool-agent={data.pools.agent.toString()}>{data.pools.agent.toString()}</strong> points
          </p>
          <p>
            Implied <strong data-odds-agent={pct(odds.agent)}>{pct(odds.agent)}%</strong>
          </p>
        </div>
      </div>
      <p className="muted">Implied odds are each pool&apos;s share of the total and move with every bet.</p>

      {series.length > 0 ? (
        <PathChart
          bound={fitBound(series.map((s) => s.candles), props.T)}
          series={series}
          title="Human and Agent consensus paths, in basis points from P0"
        />
      ) : (
        <p className="muted">Consensus paths are not frozen yet, so there is nothing to overlay.</p>
      )}
      {series.length === 1 ? <p className="muted">Only one consensus path is frozen so far.</p> : null}

      {view.state === "betting" ? (
        <>
          {/* The note belongs to the form: it shows exactly when the form renders (same state), never on its own. */}
          <Annotation text="pick a side">
            <Arrow variant="leader" size={64} rotate={4} />
          </Annotation>
          <form
            className="bet-form"
            data-bet-form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) props.onBet(side, amountText);
            }}
          >
            <fieldset>
              <legend>Which consensus will score higher?</legend>
              {(["human", "agent"] as const).map((s) => (
                <label key={s} className="radio">
                  <input
                    type="radio"
                    name="side"
                    value={SIDE_CODE[s]}
                    checked={side === s}
                    onChange={() => setSide(s)}
                    disabled={busy}
                  />{" "}
                  {s === "human" ? "Human" : "Agent"}
                </label>
              ))}
            </fieldset>
            <label>
              Points to stake
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                disabled={busy}
                aria-describedby="bet-hint"
              />
            </label>
            <p id="bet-hint" className="muted" data-remaining={remaining.toString()}>
              Your balance: {props.connected ? data.balance.toString() : "connect a wallet"} points. Per-address cap of{" "}
              {data.cap.toString()} points per round (both sides together); you can still stake{" "}
              {remaining.toString()}. You staked {data.stake.human.toString()} on Human and {data.stake.agent.toString()} on Agent.
            </p>
            {payout !== null ? (
              <p className="muted">
                At the current pools a winning bet of this size would pay about {payout.toString()} points. Later bets change this.
              </p>
            ) : null}
            {!guard.ok ? <p className="hint">{guard.reason}</p> : null}
            {closing ? <p className="error">The market window is closing: betting is disabled.</p> : null}
            <button type="submit" className="btn primary" data-bet-submit disabled={!guard.ok || busy}>
              {busy ? "Working..." : "Place bet"}
            </button>
            <p className="muted">No approval is needed: the market spends points directly. A bet cannot be undone.</p>
          </form>
        </>
      ) : null}

      {final ? (
        <div className="claim" data-claim>
          {resultKnown ? (
            <p>
              Your claim: <strong data-claim-amount={claimAmount.toString()}>{claimAmount.toString()}</strong> points
            </p>
          ) : (
            <p className="muted" data-claim-pending>
              Reading the result of the market...
            </p>
          )}
          {data.claimed ? <p className="muted">Already claimed.</p> : null}
          <button
            type="button"
            className="btn primary"
            data-claim-submit
            disabled={!claim.ok || busy}
            onClick={() => props.onClaim()}
          >
            {busy ? "Working..." : view.state === "resolved" ? "Claim winnings" : "Claim refund"}
          </button>
          {!claim.ok && !data.claimed && resultKnown ? <p className="hint">{claim.reason}</p> : null}
        </div>
      ) : null}

      <TxStatus tx={tx} onRecheck={props.onRecheck} />
    </div>
  );
}

export function TxStatus({ tx, onRecheck }: { tx: TxState; onRecheck: () => void }) {
  switch (tx.step) {
    case "idle":
      return null;
    case "checking":
      return <p className="muted" role="status">Checking the market on-chain...</p>;
    case "signing":
      return <p className="muted" role="status">Confirm in your wallet: {tx.label}.</p>;
    case "pending":
      return (
        <p className="muted" role="status">
          Waiting for confirmation: {tx.label}.{" "}
          <a href={`https://sepolia.basescan.org/tx/${tx.hash}`} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      );
    case "unconfirmed":
      return (
        <div role="alert" data-tx-unconfirmed>
          <p className="error">
            {tx.label}: {tx.message}{" "}
            <a href={`https://sepolia.basescan.org/tx/${tx.hash}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </p>
          <p className="muted">Betting and claiming stay disabled until this is resolved, so you cannot send it twice.</p>
          <button type="button" className="btn" data-recheck onClick={onRecheck}>
            Check again
          </button>
        </div>
      );
    case "confirmed":
      return (
        <p className="ok" role="status">
          Confirmed: {tx.label}.{" "}
          <a href={`https://sepolia.basescan.org/tx/${tx.hash}`} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      );
    case "failed":
      return (
        <p className="error" role="alert">
          {tx.message}{" "}
          {tx.hash ? (
            <a href={`https://sepolia.basescan.org/tx/${tx.hash}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          ) : null}
        </p>
      );
  }
}

/** Live market panel for round `roundId`: reads the chain and wires the bet and claim transactions. */
export function MarketPanel(props: { roundId: bigint; T: number; phase: Phase; closing: boolean }) {
  const { address } = useAccount();
  const reads = useMarketReads(props.roundId, address);
  const actions = useMarketActions(props.roundId, reads.refetch);

  if (reads.status === "unconfigured") {
    return <p className="muted">The contract addresses are not configured (see .env.example).</p>;
  }
  if (reads.status === "loading") return <p className="muted">Reading the market...</p>;
  if (reads.status === "error" || reads.data === undefined) {
    return <p className="error">Could not read a valid market from Base Sepolia.</p>;
  }
  return (
    <MarketPanelView
      roundId={props.roundId}
      T={props.T}
      phase={props.phase}
      closing={props.closing}
      data={reads.data}
      stale={reads.stale}
      connected={actions.connected && address !== undefined}
      correctChain={actions.correctChain}
      tx={actions.tx}
      onBet={(side, amountText) => void actions.bet(side, amountText)}
      onClaim={() => void actions.claim()}
      onRecheck={() => void actions.recheck()}
    />
  );
}
