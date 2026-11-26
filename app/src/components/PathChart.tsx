import type { Candle } from "../../../shared/score";
import { bpToY } from "@/lib/path";
import { bodyFill, HatchDefs, hatchIds } from "./ChartHatch";

const VIEW_W = 520;
const VIEW_H = 280;
const PAD = 16;
const PLOT_H = VIEW_H - 2 * PAD;
const SLOT_X = [150, 290, 430] as const;
const BODY_W = 14;

/** Series colors are tokens from globals.css: human pencil blue, agent ochre ink (raw ochre is too faint for a line). */
export const SERIES_COLOR = { human: "var(--c-human)", agent: "var(--c-agent-ink)", real: "var(--ink)" } as const;

export type ChartSeries = {
  /** Machine id, also written to `data-series` (for example "real", "human", "agent"). */
  id: string;
  label: string;
  /** A CSS color token such as `var(--c-human)`; never a hex literal (a test enforces it). Used for outlined series. */
  color: string;
  /** Real candles are hatched by direction (green up, red down); consensus paths are outlined in `color`. */
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
  const hatch = hatchIds(title);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={title}>
        <title>{title}</title>
        <HatchDefs ids={hatch} />
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
                <line
                  className={s.filled ? "wick" : "series-wick"}
                  x1={cx}
                  x2={cx}
                  y1={y(c.high)}
                  y2={y(c.low)}
                  style={s.filled ? undefined : { stroke: s.color }}
                />
                <rect
                  className={s.filled ? "body" : "series-body"}
                  x={cx - BODY_W / 2}
                  y={top}
                  width={BODY_W}
                  height={height}
                  fill={s.filled ? bodyFill(hatch, c.close >= open) : undefined}
                  style={s.filled ? undefined : { stroke: s.color }}
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
            {s.filled ? (
              <>
                <svg className="swatch-hatch" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <rect x="1" y="1" width="12" height="12" fill={bodyFill(hatch, true)} />
                </svg>
                <svg className="swatch-hatch" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <rect x="1" y="1" width="12" height="12" fill={bodyFill(hatch, false)} />
                </svg>
              </>
            ) : (
              <span className="swatch" style={{ background: s.color }} />
            )}{" "}
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
