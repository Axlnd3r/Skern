import type { Candle } from "../../../shared/score";
import { bpToY } from "@/lib/path";

const VIEW_W = 520;
const VIEW_H = 280;
const PAD = 16;
const PLOT_H = VIEW_H - 2 * PAD;
const SLOT_X = [150, 290, 430] as const;
const BODY_W = 14;

export type ChartSeries = {
  /** Machine id, also written to `data-series` (for example "real", "human", "agent"). */
  id: string;
  label: string;
  color: string;
  /** Real candles are filled; consensus paths are outlined. */
  filled: boolean;
  /** Horizontal offset inside a candle slot, so series sit side by side. */
  offset: number;
  /** The candles to draw. Only these are drawn: a series with fewer than 3 shows only those. */
  candles: readonly Candle[];
};

/**
 * Candles of one or more series over the same bp axis. Opens are implicit (open_1 = 0 bp, open_i =
 * close_(i-1)). Purely presentational: it draws exactly the candles it is given, nothing else.
 */
export function PathChart({ bound, series, title }: { bound: number; series: readonly ChartSeries[]; title: string }) {
  const y = (bp: number) => PAD + bpToY(bp, PLOT_H, bound);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={title}>
        <title>{title}</title>
        <line className="baseline" x1={0} x2={VIEW_W} y1={y(0)} y2={y(0)} />
        <text className="axis" x={4} y={y(0) - 4}>
          P0 (0 bp)
        </text>
        <text className="axis" x={4} y={PAD + 10}>
          +{bound} bp
        </text>
        <text className="axis" x={4} y={VIEW_H - 4}>
          -{bound} bp
        </text>
        {series.map((s) =>
          s.candles.map((c, i) => {
            const open = i === 0 ? 0 : (s.candles[i - 1] as Candle).close;
            const cx = (SLOT_X[i] ?? SLOT_X[2]) + s.offset;
            const top = Math.min(y(open), y(c.close));
            const height = Math.max(2, Math.abs(y(open) - y(c.close)));
            return (
              <g key={`${s.id}-${i}`} data-series={s.id} data-candle={i + 1} data-close={c.close}>
                <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={s.color} strokeWidth={2} />
                <rect
                  x={cx - BODY_W / 2}
                  y={top}
                  width={BODY_W}
                  height={height}
                  fill={s.filled ? s.color : "none"}
                  stroke={s.color}
                  strokeWidth={2}
                />
              </g>
            );
          }),
        )}
        {[1, 2, 3].map((n, i) => (
          <text key={n} className="axis" x={SLOT_X[i] as number} y={VIEW_H - 4} textAnchor="middle">
            candle {n}
          </text>
        ))}
      </svg>
      <ul className="legend" aria-label="Legend">
        {series.map((s) => (
          <li key={s.id}>
            <span className="swatch" style={{ background: s.color }} /> {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
