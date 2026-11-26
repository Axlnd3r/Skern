"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { score, type Path } from "../../../shared/score";
import {
  FLAT_HANDLES,
  boundsForT,
  bpToY,
  commitGuard,
  flatBaseline,
  handleIndex,
  handlesToPath,
  moveHandle,
  yToBp,
  type Field,
  type Handles,
} from "@/lib/path";
import type { Phase } from "@/lib/round";

const VIEW_W = 520;
const VIEW_H = 320;
const SLOT_X = [200, 330, 460] as const;
const LEFT_X = 20;
const HANDLE_R = 8;
const PAD = 16; // keeps handles at the range limits fully inside the svg
const PLOT_H = VIEW_H - 2 * PAD;
const DX: Record<Field, number> = { high: -18, close: 0, low: 18 };
const FIELDS: readonly Field[] = ["high", "close", "low"];

export type DrawChartProps = {
  /** Round tolerance in bp (scales the chart range and the baseline comparison). */
  T: number;
  phase: Phase;
  closing: boolean;
  /** True for the practice round: labeled, drawable, never committable. */
  simulated: boolean;
  connected: boolean;
  /** Why a commit is not possible for reasons outside the drawing (not registered, not enough points). */
  blocked?: string;
  /** True while a commit transaction is in progress: the button is disabled. */
  busy?: boolean;
  onCommit: (path: Path) => void;
};

/** Draggable close/high/low handles for 3 future candles. All value rules live in `@/lib/path`. */
export function DrawChart({ T, phase, closing, simulated, connected, blocked, busy = false, onCommit }: DrawChartProps) {
  const [handles, setHandles] = useState<Handles>(FLAT_HANDLES);
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const bound = boundsForT(T);
  const ctxFor = (value: number) => ({ value, min: -bound, max: bound });
  const path = handlesToPath(handles);
  const baseline = flatBaseline();
  const guard = commitGuard({ path, phase, closing, simulated, connected, ...(blocked !== undefined ? { blocked } : {}) });
  const y = (bp: number) => PAD + bpToY(bp, PLOT_H, bound);

  let preview: number | null = null;
  try {
    preview = score(path, baseline, T);
  } catch {
    preview = null;
  }

  const setValue = (index: number, value: number) => setHandles((h) => moveHandle(h, index, ctxFor(value)));

  const pointerToBp = (e: PointerEvent): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.height <= 0) return null;
    return yToBp(((e.clientY - rect.top) / rect.height) * VIEW_H - PAD, PLOT_H, bound);
  };

  const onKey = (index: number, e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const current = handles[index] as number;
    if (e.key === "ArrowUp") setValue(index, current + step);
    else if (e.key === "ArrowDown") setValue(index, current - step);
    else return;
    e.preventDefault();
  };

  return (
    <div className="draw">
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="group"
        aria-label="Draw the next 3 candles. Drag the handles, or focus one and use the arrow keys."
      >
        {/* faint flat baseline: price stays at P0 */}
        <line className="baseline" x1={LEFT_X} x2={VIEW_W - 10} y1={y(0)} y2={y(0)} />
        <text className="axis" x={LEFT_X} y={y(0) - 6}>
          P0 (0 bp), flat baseline
        </text>
        <text className="axis" x={LEFT_X} y={12}>
          +{bound} bp
        </text>
        <text className="axis" x={LEFT_X} y={VIEW_H - 2}>
          -{bound} bp
        </text>

        {path.map((c, i) => {
          const open = i === 0 ? 0 : (path[i - 1] as { close: number }).close;
          const cx = SLOT_X[i] as number;
          const top = Math.min(y(open), y(c.close));
          const bodyH = Math.max(1, Math.abs(y(open) - y(c.close)));
          return (
            <g key={i} data-testid={`candle-${i + 1}`}>
              <text className="axis" x={cx} y={VIEW_H - 2} textAnchor="middle">
                Candle {i + 1}
              </text>
              <line className="wick" x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
              <rect className={c.close >= open ? "body up" : "body down"} x={cx - 10} y={top} width={20} height={bodyH} />
            </g>
          );
        })}

        {[0, 1, 2].flatMap((candle) =>
          FIELDS.map((field) => {
            const index = handleIndex(candle, field);
            const value = handles[index] as number;
            const cx = (SLOT_X[candle] as number) + DX[field];
            return (
              <circle
                key={index}
                className={`handle h-${field}${active === index ? " active" : ""}`}
                data-handle={index}
                cx={cx}
                cy={y(value)}
                r={HANDLE_R}
                tabIndex={0}
                role="slider"
                aria-label={`Candle ${candle + 1} ${field}`}
                aria-orientation="vertical"
                aria-valuemin={-bound}
                aria-valuemax={bound}
                aria-valuenow={value}
                aria-valuetext={`${value} bp`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setActive(index);
                }}
                onPointerMove={(e) => {
                  if (active !== index) return;
                  const bp = pointerToBp(e);
                  if (bp !== null) setValue(index, bp);
                }}
                onPointerUp={() => setActive(null)}
                onPointerCancel={() => setActive(null)}
                onKeyDown={(e) => onKey(index, e)}
              />
            );
          }),
        )}
      </svg>

      <table className="values" aria-label="Path values in basis points relative to P0">
        <thead>
          <tr>
            <th>Candle</th>
            <th>Close</th>
            <th>High</th>
            <th>Low</th>
          </tr>
        </thead>
        <tbody>
          {path.map((c, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td data-field={`c${i + 1}-close`}>{c.close}</td>
              <td data-field={`c${i + 1}-high`}>{c.high}</td>
              <td data-field={`c${i + 1}-low`}>{c.low}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Values are basis points (bp) relative to P0. A high can not go below the candle&apos;s open or close, a low can not
        go above them; moving a close widens the wicks that depend on it. Price history is not shown yet: no market data
        feed is connected.
      </p>
      {preview !== null ? (
        <p className="muted" data-testid="baseline-score">
          Match with the flat baseline: {preview} / 100. This only compares your drawing with a flat line; it is not your
          result.
        </p>
      ) : null}

      <div className="row">
        <button type="button" className="btn ghost" onClick={() => setHandles(FLAT_HANDLES)}>
          Reset to flat
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!guard.ok || busy}
          title={guard.ok ? undefined : guard.reason}
          onClick={() => {
            // Re-check at click time on the exact path being committed.
            const p = handlesToPath(handles);
            if (commitGuard({ path: p, phase, closing, simulated, connected, ...(blocked !== undefined ? { blocked } : {}) }).ok) onCommit(p);
          }}
        >
          {busy ? "Working..." : "Commit path"}
        </button>
      </div>
      {!guard.ok ? (
        <p className="muted" data-testid="commit-blocked">
          {guard.reason}
        </p>
      ) : null}
    </div>
  );
}
