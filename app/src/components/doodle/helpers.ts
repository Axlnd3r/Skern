import type { CSSProperties } from "react";

/** Longest text a hand-written annotation may carry; anything longer is a sentence and belongs in body text. */
export const ANNOTATION_MAX = 24;

/** Clips an annotation to `ANNOTATION_MAX` characters (the hand face is for a few words, never for disclosures). */
export function shortNote(text: string): string {
  return text.length > ANNOTATION_MAX ? text.slice(0, ANNOTATION_MAX).trimEnd() : text;
}

/**
 * Text for the rotating ring of the sticker: `base` repeated until it holds at least `minChars` characters, so the
 * ring is always evenly filled (the SVG stretches the letter spacing to the circumference with textLength).
 */
export function fillRing(base: string, minChars = 44): string {
  const unit = base.endsWith(" ") ? base : `${base} `;
  return unit.repeat(Math.max(1, Math.ceil(minChars / unit.length)));
}

/** Font size (in the 120-unit sticker box) for the centre word, so a 7-letter word still fits inside the inner ring. */
export function stickerFontSize(label: string): number {
  return label.length > 7 ? 14 : label.length > 5 ? 17 : 20;
}

/** Inline size and orientation of a mark. Rotation and mirroring go through variables so keyframes can reuse them. */
export function markStyle(width: number, ratio: number, rotate = 0, flip = false): CSSProperties {
  return {
    width,
    height: Math.round(width * ratio),
    "--rot": `${rotate}deg`,
    "--flip": flip ? -1 : 1,
  } as CSSProperties;
}
