"use client";

import { useState } from "react";
import { HOUSE_LABEL } from "@/lib/disclaimer";
import { baselineLine, cardParamsFor, cardUrl, deriveMyResult, nearMissLine, type EntryRead, type MyResult } from "@/lib/near";
import { outcomeLine, type RevealReads } from "@/lib/reveal";
import type { Phase } from "@/lib/round";

export type ResultCardProps = {
  result: MyResult;
  /** Consensus scores stored by the contract; null when that side has no consensus. */
  humanScore: number | null;
  agentScore: number | null;
  /** Flat-path baseline score from the contract. */
  baseline?: number;
  roundId?: string;
  ticker?: string;
};

const MESSAGES: Record<Exclude<MyResult["state"], "ready">, string> = {
  "no-wallet": "Connect your wallet to see your own score for this round.",
  loading: "Reading your entry...",
  error: "Could not read a valid entry for your wallet from the chain.",
  "no-entry": "Your wallet has no entry in this round, so there is no personal score.",
  unrevealed: "Your entry was not revealed in time, so it has no score and its stake was burned.",
  "agent-entry": "This card is for human entries. Agent entries are scored on-chain against the real candles.",
};

/**
 * Screen 5: the user's score against the Agent consensus and the flat baseline, the market outcome
 * (equal consensus scores are a tie and stakes are refunded) and a shareable image. All text comes from
 * the pure functions in `near.ts` and `reveal.ts`; this component only lays it out.
 */
export function ResultCard(props: ResultCardProps) {
  const { result, humanScore, agentScore, baseline } = props;
  const score = result.state === "ready" ? result.score : null;
  const hasAgent = agentScore !== null;
  const img =
    score !== null && agentScore !== null
      ? cardUrl(
          cardParamsFor({
            me: score,
            agent: agentScore,
            ...(baseline !== undefined ? { base: baseline } : {}),
            ...(props.roundId !== undefined ? { round: props.roundId } : {}),
            ...(props.ticker !== undefined ? { ticker: props.ticker } : {}),
          }),
        )
      : null;

  return (
    <section className="card result" data-result-state={result.state} aria-label="Your result">
      <h2>Your result</h2>
      {score === null ? (
        <p className="muted">{MESSAGES[result.state as Exclude<MyResult["state"], "ready">]}</p>
      ) : (
        <>
          <p className="big-score" data-my-score={score}>
            {score}
          </p>
          {hasAgent ? <p>{nearMissLine(score, agentScore)}</p> : <p className="muted">No Agent consensus took part, so there is nothing to beat.</p>}
          {baseline !== undefined ? <p>{baselineLine(score, baseline)}</p> : null}
        </>
      )}

      <p>{outcomeLine(humanScore, agentScore)}</p>

      {img !== null ? (
        <div className="share">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img} alt="Share card with your score" width={600} height={315} className="share-img" />
          <a className="btn link-btn" href={img} target="_blank" rel="noopener noreferrer">
            Open the share image
          </a>
        </div>
      ) : null}

      <p className="muted">
        Testnet, points only. The Agent consensus may include project-run agents, which are labeled{" "}
        <span className="tag">{HOUSE_LABEL}</span>. Moves are shown in basis points from P0, never as prices.
      </p>
    </section>
  );
}

export type ResultSectionViewProps = {
  phase: Phase;
  /** Settled-round reads (real candles, consensus scores, baseline); undefined until they are read. */
  reads: RevealReads | undefined;
  /** Round tolerance in bp, passed to the shared score. */
  T: number;
  roundId: bigint;
  ticker: string;
  connected: boolean;
  /** The wallet's own entry: undefined while loading, null when the read failed or was malformed. */
  entry: EntryRead | null | undefined;
};

/**
 * Screen 5 entry point on the reveal page. Renders nothing unless the round is settled and its reads
 * exist (the real candles do not exist before that). The result stays behind a button so the reveal
 * animation above it is not spoiled.
 */
export function ResultSectionView(props: ResultSectionViewProps) {
  const [shown, setShown] = useState(false);
  const { reads } = props;
  if (props.phase !== "settled" || reads === undefined) return null;
  if (!shown) {
    return (
      <button type="button" className="btn primary" onClick={() => setShown(true)}>
        Show my result
      </button>
    );
  }
  const scores = reads.scores;
  if (scores === undefined) {
    return <p className="error">The consensus scores could not be read from the chain, so there is no result to show.</p>;
  }
  const result = deriveMyResult({ connected: props.connected, entry: props.entry, real: reads.real, T: props.T });
  return (
    <ResultCard
      result={result}
      humanScore={scores.humanPresent ? scores.human : null}
      agentScore={scores.agentPresent ? scores.agent : null}
      {...(reads.baseline !== undefined ? { baseline: reads.baseline } : {})}
      roundId={props.roundId.toString()}
      ticker={props.ticker.toUpperCase()}
    />
  );
}
