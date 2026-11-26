import { useId, type CSSProperties, type ReactNode } from "react";
import { RING_LENGTH, markStyle, ringFontSize, stickerFontSize } from "./helpers";

/*
  Original hand-drawn marks (no characters, no faces). Every mark is a stroke in the ink color with round caps,
  irregular control points and a little overshoot where a pen would overshoot. They are decorative only:
  aria-hidden, not focusable, and `.doodle` sets pointer-events: none, so they never take a click.
  Size, color, draw-on and the hover and stamp motions live in globals.css (all motion inside
  prefers-reduced-motion: no-preference; reduced motion shows the finished drawing).
*/

export type MarkProps = {
  className?: string;
  /** Width in px; the height follows the mark's own aspect ratio. */
  size?: number;
  /** Degrees. */
  rotate?: number;
  flip?: boolean;
};

function classes(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** One pen stroke. `pathLength=1` lets the CSS draw-on use a dash of length 1 whatever the real length is. */
function Stroke({ d }: { d: string }) {
  return <path d={d} pathLength={1} />;
}

function Svg(props: {
  kind: string;
  viewBox: string;
  ratio: number;
  defaultWidth: number;
  mark: MarkProps;
  draw?: boolean;
  /** Marks that stretch to their parent (CSS sizes them) carry no inline width and height. */
  fluid?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { mark } = props;
  const sized = markStyle(mark.size ?? props.defaultWidth, props.ratio, mark.rotate, mark.flip);
  const style: CSSProperties = props.fluid
    ? ({ "--rot": `${mark.rotate ?? 0}deg`, "--flip": mark.flip ? -1 : 1, ...props.style } as CSSProperties)
    : { ...sized, ...props.style };
  return (
    <svg
      className={classes("doodle", `doodle-${props.kind}`, props.draw && "doodle-draw", mark.className)}
      viewBox={props.viewBox}
      preserveAspectRatio={props.fluid ? "none" : undefined}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

/** Two pen strokes under a title. Width follows the parent (CSS), the height is fixed. */
export function Underline(props: MarkProps) {
  return (
    <Svg kind="underline" viewBox="0 0 200 12" ratio={0.06} defaultWidth={200} mark={props} draw fluid>
      <Stroke d="M3 7.5 C 22 4.5, 40 9.5, 64 6.2 S 108 4.2, 134 7 S 176 5.2, 197 6.4" />
      <Stroke d="M30 10.6 C 58 8.8, 92 11.4, 128 9.6" />
    </Svg>
  );
}

/** A loose wave, like a divider drawn with a pen. */
export function Squiggle(props: MarkProps) {
  return (
    <Svg kind="squiggle" viewBox="0 0 160 16" ratio={0.1} defaultWidth={128} mark={props} draw>
      <Stroke d="M3 9 C 10 2, 17 2, 22 8 S 33 15, 41 8 S 52 1.5, 60 8.5 S 72 14.5, 80 7.5 S 92 2, 100 8 S 112 14, 120 8.5 S 131 3, 138 7.5 S 151 13, 157 6.5" />
    </Svg>
  );
}

/** Five-point star in one stroke that overshoots where it closes. Wiggles when its card is hovered. */
export function Star(props: MarkProps) {
  return (
    <Svg kind="star" viewBox="0 0 32 32" ratio={1} defaultWidth={24} mark={props}>
      <Stroke d="M16 3 L20.5 12 L30.5 13.2 L22.6 19.8 L25.2 29.4 L16.2 23.8 L7 29.6 L9.8 19.6 L2 13.2 L11.8 12 L16.6 2.4 L17.4 5" />
    </Svg>
  );
}

/** Four-point sparkle with a couple of loose ticks. */
export function Sparkle(props: MarkProps) {
  return (
    <Svg kind="sparkle" viewBox="0 0 30 30" ratio={1} defaultWidth={26} mark={props}>
      <Stroke d="M14 2.5 C 15 9, 18 12.5, 26 14 C 18.5 15.5, 15.2 19, 14.4 26.5 C 13 19.5, 9.5 15.8, 2.2 13.8 C 9.8 12.4, 13 9, 14.3 2" />
      <Stroke d="M24 3.5 L26.6 1.4" />
      <Stroke d="M4.5 24 L2.4 26.3" />
    </Svg>
  );
}

/**
 * A curved arrow. `leader` is the long lazy S-curve that runs from a handwritten note to the thing it talks about;
 * the default is a short bend with the head at the end.
 */
export function Arrow(props: MarkProps & { variant?: "curved" | "leader" }) {
  if (props.variant === "leader") {
    return (
      <Svg kind="arrow-leader" viewBox="0 0 96 56" ratio={56 / 96} defaultWidth={72} mark={props} draw>
        <Stroke d="M3 6 C 20 4, 26 30, 48 30 S 74 44, 91.5 50.6" />
        <Stroke d="M83.5 41.5 C 86.5 45, 89 48, 91.5 50.3 C 88 51, 84 51.6, 80 52.4" />
      </Svg>
    );
  }
  return (
    <Svg kind="arrow" viewBox="0 0 72 48" ratio={48 / 72} defaultWidth={56} mark={props} draw>
      <Stroke d="M4 9 C 17 1.5, 43 5, 59 38.5" />
      <Stroke d="M49.8 31 C 54 33.5, 57.5 36, 59.3 38.8 C 60 34, 61 30.5, 62 26.5" />
    </Svg>
  );
}

/** A small flat-bottomed cloud: used where the page is waiting for data. */
export function Cloud(props: MarkProps) {
  return (
    <Svg kind="cloud" viewBox="0 0 64 40" ratio={40 / 64} defaultWidth={56} mark={props} draw>
      <Stroke d="M12 33 C 4 33, 2 22, 10 20 C 8 11, 20 6, 27 12 C 31 3, 46 5, 47 16 C 56 14, 62 23, 55 29 C 53 34.5, 48 34, 44 33.6 C 34 35, 22 32.5, 11 33.8 C 8.5 34, 7.2 33, 6.5 31.6" />
    </Svg>
  );
}

/**
 * A double loop drawn around a number. The parent needs `position: relative`; CSS stretches the loop to the parent
 * with a non-scaling stroke, so the line keeps its pen width.
 */
export function ScribbleCircle(props: MarkProps) {
  return (
    <Svg kind="circle" viewBox="0 0 120 60" ratio={0.5} defaultWidth={120} mark={props} fluid>
      <Stroke d="M62 5 C 30 3, 6 14, 7 31 C 8 50, 40 57, 68 55 C 99 53, 116 42, 113 25 C 110 9, 84 3, 52 7 C 30 10, 14 18, 14 30" />
    </Svg>
  );
}

/** A pencil lying on its side; rotate it with `rotate`. */
export function Pencil(props: MarkProps) {
  return (
    <Svg kind="pencil" viewBox="0 0 64 24" ratio={24 / 64} defaultWidth={64} mark={props} draw>
      <Stroke d="M5 12.2 L15 5.2 C 28 6.4, 44 6, 55.5 7.4 C 59 9.6, 59.4 14.4, 55.8 16.6 C 44 17.6, 28 17.9, 14.6 19 L4.6 12.6" />
      <Stroke d="M47 7.2 C 48 10, 47.8 14, 47 17.3" />
      <Stroke d="M15 5.2 C 16.5 9, 16.2 15, 14.6 19" />
      <Stroke d="M5.2 12.4 L8.6 11.6" />
    </Svg>
  );
}

/** A pencil tick, drawn on when a phase step is done. */
export function Tick(props: MarkProps) {
  return (
    <Svg kind="tick" viewBox="0 0 14 12" ratio={12 / 14} defaultWidth={12} mark={props} draw>
      <Stroke d="M1.5 6.5 C 3.5 8, 4.8 9.6, 5.8 10.8 C 7.5 6.6, 10 3.4, 12.8 1.2" />
    </Svg>
  );
}

/**
 * A rubber-stamp badge: a hand-drawn double ring, the phase word in the middle and `ring` written around it on a
 * circle path. Mount it with a new `key` when the phase changes and the stamp "lands" again (CSS animation on mount).
 * It repeats text that is already on the page, so it is hidden from assistive technology.
 */
export function Sticker(props: MarkProps & { label: string; ring: string; tilt?: number }) {
  const guideId = `sticker-guide-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const tilt = props.tilt ?? -7;
  const fontSize = stickerFontSize(props.label);
  return (
    <Svg kind="sticker" viewBox="0 0 120 120" ratio={1} defaultWidth={92} mark={props} fluid style={{ "--tilt": `${tilt}deg` } as CSSProperties}>
      <defs>
        {/* The invisible track the ring text follows: from the left, over the top, clockwise. */}
        <path id={guideId} d="M18.5 60 A41.5 41.5 0 1 1 101.5 60 A41.5 41.5 0 1 1 18.5 60" />
      </defs>
      <Stroke d="M60 4 C 90 3, 117 28, 116 60 C 115 92, 90 117, 58 116 C 28 115, 4 91, 5 60 C 6 30, 30 5, 63 4.5 C 68 4.3, 71 5, 73 6.2" />
      <path
        className="sticker-disc"
        d="M60 24 C 80 24, 96 40, 95.5 61 C 95 80, 79 96, 59 95.5 C 39 95, 24 80, 24.5 59 C 25 40, 40 24.5, 61 24.5 C 64 24.4, 66 25, 67.5 26"
      />
      <g className="sticker-ring">
        <text className="sticker-ring-text" style={{ fontSize: ringFontSize(props.ring) }}>
          <textPath href={`#${guideId}`} textLength={RING_LENGTH} lengthAdjust="spacing">
            {props.ring}
          </textPath>
        </text>
      </g>
      <text className="sticker-label" x={60} y={60 + fontSize * 0.36} textAnchor="middle" style={{ fontSize }}>
        {props.label}
      </text>
      <path className="sticker-rule" d="M42 76 C 52 74.2, 68 76.6, 78 74.6" />
    </Svg>
  );
}
