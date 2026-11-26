// Pure geometry for the short hand-written labels next to a draw-chart handle ("high", "close", "low"),
// each joined to its handle by a dashed leader line. Display only: it never touches a handle value.

import type { Field } from "./path";

export type HandleLabel = {
  text: string;
  /** Text anchor point (the baseline is `ty + TEXT_DROP`). */
  tx: number;
  ty: number;
  anchor: "start" | "end";
  /** Leader line from the edge of the handle to just before the text. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** Which way each label leans away from its handle: high up-left, close up-right, low down-right. */
const LEAN: Record<Field, { sx: -1 | 1; sy: -1 | 1; anchor: "start" | "end" }> = {
  high: { sx: -1, sy: -1, anchor: "end" },
  close: { sx: 1, sy: -1, anchor: "start" },
  low: { sx: 1, sy: 1, anchor: "start" },
};

export const LABEL_DX = 30;
export const LABEL_DY = 24;
/** Baseline offset that centers the text on `ty`. */
export const TEXT_DROP = 5;
const GAP = 4;

/**
 * Where the label of a handle at (cx, cy) goes inside an svg `viewH` tall. The label follows the handle but
 * its vertical position is clamped into [minY, viewH - bottomPad], so it never leaves the picture.
 */
export function handleLabel(
  field: Field,
  cx: number,
  cy: number,
  handleR: number,
  viewH: number,
  minY = 14,
  bottomPad = 26,
): HandleLabel {
  const { sx, sy, anchor } = LEAN[field];
  const tx = cx + sx * LABEL_DX;
  const ty = Math.min(viewH - bottomPad, Math.max(minY, cy + sy * LABEL_DY));
  const ex = tx - sx * GAP;
  const dx = ex - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const from = handleR + 2;
  return { text: field, tx, ty, anchor, x1: cx + (dx / len) * from, y1: cy + (dy / len) * from, x2: ex, y2: ty };
}
