import { gapOf, outcomeOf, trendPoints, type RoundSummary, type TrendBox } from "@/lib/history";

const BOX: TrendBox = { width: 560, height: 260, padLeft: 64, padRight: 16, padTop: 16, padBottom: 44 };

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Human minus Agent consensus score per round (points, -100..100). Above the zero line the Human
 * consensus scored higher. Encoded redundantly (position, label, marker shape and color): circle and
 * blue for a Human win, square and orange for an Agent win, diamond and grey for a tie. Rounds with no
 * result (void, open, one side missing) have no point. The table below the chart carries the same data.
 */
export function TrendChart({ rounds }: { rounds: readonly RoundSummary[] }) {
  const decided = rounds.filter((r) => gapOf(r) !== null);
  if (decided.length === 0) {
    return <p className="muted">No decided round yet, so there is no gap trend to draw.</p>;
  }
  const { zeroY, points } = trendPoints(decided.map((r) => gapOf(r) as number), BOX);
  const top = BOX.padTop;
  const bottom = BOX.height - BOX.padBottom;
  const right = BOX.width - BOX.padRight;
  const title = "Human minus Agent consensus score per round, in points";
  const desc = decided.map((r) => `round ${r.id}: ${signed(gapOf(r) as number)}`).join(", ");
  const showEvery = decided.length > 12 ? Math.ceil(decided.length / 12) : 1;

  return (
    <figure className="trend-fig">
      <svg className="trend" viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-labelledby="trend-title trend-desc">
        <title id="trend-title">{title}</title>
        <desc id="trend-desc">{desc}</desc>
        <line className="trend-grid" x1={BOX.padLeft} x2={right} y1={top} y2={top} />
        <line className="trend-zero" x1={BOX.padLeft} x2={right} y1={zeroY} y2={zeroY} />
        <line className="trend-grid" x1={BOX.padLeft} x2={right} y1={bottom} y2={bottom} />
        <text className="trend-axis" x={BOX.padLeft - 6} y={top + 4} textAnchor="end">
          +100
        </text>
        <text className="trend-axis" x={BOX.padLeft - 6} y={zeroY + 4} textAnchor="end">
          0
        </text>
        <text className="trend-axis" x={BOX.padLeft - 6} y={bottom + 4} textAnchor="end">
          -100
        </text>
        <text className="trend-axis" x={BOX.padLeft + 4} y={top + 14}>
          Human ahead
        </text>
        <text className="trend-axis" x={BOX.padLeft + 4} y={bottom - 6}>
          Agent ahead
        </text>
        <polyline className="trend-line" fill="none" points={points.map((p) => `${p.x},${p.y}`).join(" ")} />
        {points.map((p, i) => {
          const r = decided[i] as RoundSummary;
          const o = outcomeOf(r);
          const label = `Round ${r.id}: gap ${signed(p.gap)}`;
          return (
            <g key={String(r.id)} data-round={String(r.id)} data-gap={p.gap}>
              <title>{label}</title>
              {o === "human" ? (
                <circle className="mk-human" cx={p.x} cy={p.y} r={6} />
              ) : o === "agent" ? (
                <rect className="mk-agent" x={p.x - 6} y={p.y - 6} width={12} height={12} />
              ) : (
                <rect className="mk-tie" x={p.x - 5} y={p.y - 5} width={10} height={10} transform={`rotate(45 ${p.x} ${p.y})`} />
              )}
              {i % showEvery === 0 || i === points.length - 1 ? (
                <text className="trend-axis" x={p.x} y={bottom + 16} textAnchor="middle">
                  #{String(r.id)}
                </text>
              ) : null}
            </g>
          );
        })}
        <text className="trend-axis" x={(BOX.padLeft + right) / 2} y={BOX.height - 6} textAnchor="middle">
          Round (oldest to newest)
        </text>
        <text className="trend-axis" x={12} y={(top + bottom) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(top + bottom) / 2})`}>
          Human score minus Agent score
        </text>
      </svg>
      <figcaption>
        <ul className="legend" aria-label="Legend">
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <circle className="mk-human" cx="6" cy="6" r="5" />
            </svg>{" "}
            Human scored higher
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <rect className="mk-agent" x="1" y="1" width="10" height="10" />
            </svg>{" "}
            Agent scored higher
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <rect className="mk-tie" x="3" y="3" width="6" height="6" transform="rotate(45 6 6)" />
            </svg>{" "}
            Tie
          </li>
        </ul>
      </figcaption>
    </figure>
  );
}
