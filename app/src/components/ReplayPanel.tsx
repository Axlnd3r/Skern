"use client";

import { useState } from "react";
import { replayProps, type RoundSummary } from "@/lib/history";
import { RevealPlayer } from "./RevealPlayer";

export const SIMULATED_LABEL = "SIMULATED";

/** The visible label of a simulated row. Chain rows never get it. */
export function SimulatedTag() {
  return (
    <span className="tag sim" data-simulated-tag>
      {SIMULATED_LABEL}
    </span>
  );
}

/**
 * Replay of a settled round (for recording). It mounts the same `RevealPlayer` the live reveal screen
 * uses, with props from `replayProps`, so the frames and scores come from the same `revealFrame`.
 * Rounds that are void, open or unreadable are not offered.
 */
export function ReplayPanel(props: { rounds: readonly RoundSummary[]; initialStep?: number; autoPlay?: boolean }) {
  const replayable = props.rounds.filter((r) => replayProps(r) !== null);
  const [picked, setPicked] = useState<string | null>(null);
  if (replayable.length === 0) {
    return <p className="muted">No settled round to replay yet.</p>;
  }
  const selected = replayable.find((r) => String(r.id) === picked) ?? (replayable[replayable.length - 1] as RoundSummary);
  const p = replayProps(selected);
  if (p === null) return null;
  return (
    <div className="replay">
      <label className="replay-pick">
        Round to replay{" "}
        <select value={String(selected.id)} onChange={(e) => setPicked(e.target.value)}>
          {replayable.map((r) => (
            <option key={String(r.id)} value={String(r.id)}>
              #{String(r.id)} {r.ticker}
              {r.simulated ? ` (${SIMULATED_LABEL})` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="stock">
        <span className="ticker">{selected.ticker}</span> <span className="muted">round #{String(selected.id)}</span>
        {selected.simulated ? <SimulatedTag /> : null}
      </p>
      <RevealPlayer
        // A different round restarts the replay from candle 0.
        key={`${selected.id}-${selected.simulated ? "sim" : "chain"}`}
        {...p}
        {...(props.initialStep !== undefined ? { initialStep: props.initialStep } : {})}
        {...(props.autoPlay !== undefined ? { autoPlay: props.autoPlay } : {})}
      />
    </div>
  );
}
