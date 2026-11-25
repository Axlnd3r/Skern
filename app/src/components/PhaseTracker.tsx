import { PHASES, type Phase } from "@/lib/round";

const TITLES: Record<Phase, string> = {
  commit: "Commit",
  reveal: "Reveal",
  market: "Market",
  play: "Play",
  settled: "Settled",
  void: "Void",
};

/** Thin presentation of the phase sequence; a void round replaces the tail with a "Void" step. */
export function PhaseTracker({ phase, closing = false }: { phase: Phase; closing?: boolean }) {
  const steps: readonly Phase[] = phase === "void" ? ["commit", "reveal", "market", "play", "void"] : PHASES;
  const currentIdx = phase === "void" ? steps.length - 1 : steps.indexOf(phase);
  return (
    <ol className="tracker" aria-label="Round phases">
      {steps.map((p, i) => (
        <li
          key={p}
          className={i < currentIdx ? "done" : i === currentIdx ? "current" : "todo"}
          aria-current={i === currentIdx ? "step" : undefined}
        >
          {TITLES[p]}
          {i === currentIdx && closing ? <span className="closing"> closing</span> : null}
        </li>
      ))}
    </ol>
  );
}
