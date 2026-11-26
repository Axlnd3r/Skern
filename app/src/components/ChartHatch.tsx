/** Distance between hatch strokes, in svg units. */
const HATCH = 5;

export type HatchIds = { up: string; down: string };

/**
 * Pattern ids for one chart. Ids are document-wide, so each chart passes its own `key` (its title); the markup is
 * a pure function of the props (no random or position-dependent ids), and two charts that share a key draw
 * identical patterns, so a duplicate id is harmless.
 */
export function hatchIds(key: string): HatchIds {
  const base = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return { up: `hatch-up-${base}`, down: `hatch-down-${base}` };
}

/**
 * The two candle fills, drawn like pen hatching: up candles get `///` strokes in candle green, down candles
 * `\\` strokes in candle red, so direction reads from the hatch angle and not from color alone. The strokes
 * lie over card-colored paper; the colors come from the stylesheet (.hatch-*).
 */
export function HatchDefs({ ids }: { ids: HatchIds }) {
  return (
    <defs>
      <pattern id={ids.up} className="hatch hatch-up" patternUnits="userSpaceOnUse" width={HATCH} height={HATCH} patternTransform="rotate(45)">
        <rect className="hatch-paper" width={HATCH} height={HATCH} />
        <line x1={HATCH / 2} y1={-1} x2={HATCH / 2} y2={HATCH + 1} />
      </pattern>
      <pattern id={ids.down} className="hatch hatch-down" patternUnits="userSpaceOnUse" width={HATCH} height={HATCH} patternTransform="rotate(-45)">
        <rect className="hatch-paper" width={HATCH} height={HATCH} />
        <line x1={HATCH / 2} y1={-1} x2={HATCH / 2} y2={HATCH + 1} />
      </pattern>
    </defs>
  );
}

/** `fill` value for a body: hatched by direction (a flat body counts as up). */
export function bodyFill(ids: HatchIds, up: boolean): string {
  return `url(#${up ? ids.up : ids.down})`;
}
