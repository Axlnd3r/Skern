"use client";

import { useEffect, useMemo, useState } from "react";
import type { Path } from "../../../shared/score";
import {
  STEP_COUNT,
  STEP_MS,
  clampStep,
  fitBound,
  nextStep,
  outcomeLine,
  revealFrame,
  scoresAgree,
  type ConsensusScores,
} from "@/lib/reveal";
import { PathChart, SERIES_COLOR, type ChartSeries } from "./PathChart";

export type RevealPlayerProps = {
  /** The three real candles posted by the keeper (valid, int32 bp relative to P0). */
  real: Path;
  /** Frozen consensus paths, or null when that side has none. */
  human: Path | null;
  agent: Path | null;
  /** Round tolerance in bp. */
  T: number;
  /** The scores the contract stored, used to cross-check the local replay. */
  onchain?: ConsensusScores;
  /** Score of the flat (all zero) path, as stored on-chain. */
  baseline?: number;
  sourceHash?: string;
  /** First step shown (default 0). A faithful replay always starts from here. */
  initialStep?: number;
  /** Advance one candle every STEP_MS (default true). */
  autoPlay?: boolean;
};

function shortHash(h: string): string {
  return `${h.slice(0, 10)}...${h.slice(-6)}`;
}

/**
 * Animated reveal of the real candles against both consensus paths. All values come from the pure
 * `revealFrame` (visible candles, live score from the shared `score`); this component only steps a
 * counter and draws. Candle n exists in the output only once the step counter reached n.
 */
export function RevealPlayer(props: RevealPlayerProps) {
  const { real, human, agent, T, onchain, baseline, sourceHash } = props;
  const [step, setStep] = useState(() => clampStep(props.initialStep ?? 0));
  const [playing, setPlaying] = useState(props.autoPlay ?? true);

  useEffect(() => {
    if (!playing || step >= STEP_COUNT) return;
    const t = setTimeout(() => setStep((s) => nextStep(s)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step]);

  const frame = useMemo(() => revealFrame({ real, human, agent, T }, step), [real, human, agent, T, step]);

  // The axis is fitted to the consensus paths and the candles revealed so far, never to hidden candles.
  const bound = fitBound([...(human ? [human] : []), ...(agent ? [agent] : []), frame.real], T);
  const series: ChartSeries[] = [
    ...(human ? [{ id: "human", label: "Human consensus", color: SERIES_COLOR.human, filled: false, offset: -30, candles: human }] : []),
    { id: "real", label: "Real candles", color: SERIES_COLOR.real, filled: true, offset: 0, candles: frame.real },
    ...(agent ? [{ id: "agent", label: "Agent consensus", color: SERIES_COLOR.agent, filled: false, offset: 30, candles: agent }] : []),
  ];

  const agrees = frame.done && onchain ? scoresAgree(frame, onchain) : null;

  return (
    <div className="reveal">
      <p className="muted" aria-live="polite">
        Candle {frame.step} of {STEP_COUNT} revealed
      </p>
      <PathChart bound={bound} series={series} title="Consensus paths against the real candles, in basis points from P0" />

      <table className="values" aria-label="Scores">
        <thead>
          <tr>
            <th>{frame.done ? "Final score" : "Score so far"}</th>
            <th>0..100</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Human consensus</td>
            <td>
              {human === null ? (
                <span className="muted">No human consensus</span>
              ) : frame.humanScore === null ? (
                <span className="muted">-</span>
              ) : (
                <strong data-score-human={frame.humanScore}>{frame.humanScore}</strong>
              )}
            </td>
          </tr>
          <tr>
            <td>Agent consensus</td>
            <td>
              {agent === null ? (
                <span className="muted">No agent consensus</span>
              ) : frame.agentScore === null ? (
                <span className="muted">-</span>
              ) : (
                <strong data-score-agent={frame.agentScore}>{frame.agentScore}</strong>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {!frame.done ? (
        <p className="hint" data-partial-note>
          Score so far is an estimate: it assumes the candles not yet revealed follow this path&apos;s own values.
          The next candle still opens at the real close, so it can differ, and the score can still move. Only the
          final score counts.
        </p>
      ) : (
        <>
          {agrees !== false ? <p>{outcomeLine(human ? frame.humanScore : null, agent ? frame.agentScore : null)}</p> : null}
          {agrees === true ? <p className="ok">Matches the on-chain consensus scores.</p> : null}
          {agrees === false ? (
            <p className="error" role="alert">
              This replay does not match the on-chain consensus scores. Do not rely on it.
            </p>
          ) : null}
        </>
      )}

      {baseline !== undefined ? (
        <p className="muted">A flat path (price stays at P0) scores {baseline}; entries earn points only above it.</p>
      ) : null}
      {sourceHash ? (
        <p className="muted">
          Real candles were posted on-chain by the project keeper (source hash {shortHash(sourceHash)}), shown as basis
          point moves from P0.
        </p>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStep(0);
            setPlaying(true);
          }}
        >
          Replay
        </button>
        <button type="button" className="btn" disabled={frame.done} onClick={() => setStep((s) => nextStep(s))}>
          Next candle
        </button>
        <button
          type="button"
          className="btn"
          disabled={frame.done}
          onClick={() => {
            setPlaying(false);
            setStep(STEP_COUNT);
          }}
        >
          Skip to the end
        </button>
      </div>
    </div>
  );
}
