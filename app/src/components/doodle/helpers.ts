import type { CSSProperties } from "react";

/** Longest text a hand-written annotation may carry; anything longer is a sentence and belongs in body text. */
export const ANNOTATION_MAX = 24;

/** Clips an annotation to `ANNOTATION_MAX` characters (the hand face is for a few words, never for disclosures). */
export function shortNote(text: string): string {
  return text.length > ANNOTATION_MAX ? text.slice(0, ANNOTATION_MAX).trimEnd() : text;
}

/** Length (SVG units) the ring text is stretched to; the guide circle has a circumference of about 261. */
export const RING_LENGTH = 256;
/** Widest round number the ring shows in full; a longer id is cut to its last digits behind an ellipsis. */
export const RING_MAX_DIGITS = 9;
/**
 * Average advance of the ring text in em, rounded up from what Chrome measured for Work Sans 700 (stage 4 render
 * check): 0.54 em/char for "ROUND 7 ...", 0.56 for the worst 9-digit text ("ROUND 888888888 ..." at 10px is 224 units
 * against a 256 ring). The margin keeps the estimate above the real width in other engines too.
 */
export const RING_EM = 0.6;
const RING_MAX_FONT = 10;
/** Share of `RING_LENGTH` the natural text width may fill, so letter spacing never has to go negative. */
const RING_FILL = 0.94;

/** The round id as shown on the ring: at most `RING_MAX_DIGITS` characters, so chain data cannot make the ring grow. */
export function ringRoundLabel(roundId: bigint): string {
  const digits = roundId.toString();
  return digits.length > RING_MAX_DIGITS ? `…${digits.slice(-(RING_MAX_DIGITS - 1))}` : digits;
}

/**
 * Font size (SVG units) for the ring text so its natural width fits `RING_LENGTH` with spare room: the SVG then only
 * adds spacing (lengthAdjust="spacing") and never squeezes glyphs into each other.
 */
export function ringFontSize(text: string): number {
  const fit = (RING_LENGTH * RING_FILL) / (Math.max(1, text.length) * RING_EM);
  return Math.min(RING_MAX_FONT, Math.floor(fit * 10) / 10);
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
