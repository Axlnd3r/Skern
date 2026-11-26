// Colors of the share card. The card is rendered by satori, which cannot read CSS variables, so the values
// are literals here; globals.contrast.test.ts fails if any of them drifts from the matching :root token.
export const CARD_TOKENS = {
  "--paper": "#f6f1e4",
  "--card": "#fffdf6",
  "--ink": "#161513",
  "--muted": "#5c574c",
  "--green": "#1a7a40",
  "--red": "#bf3329",
  "--blue": "#2b4fb8",
  "--ochre": "#d99a00",
  "--ochre-ink": "#7a5600",
  "--hilite": "#fbe6a2",
} as const;

export const C = {
  paper: CARD_TOKENS["--paper"],
  card: CARD_TOKENS["--card"],
  ink: CARD_TOKENS["--ink"],
  muted: CARD_TOKENS["--muted"],
  green: CARD_TOKENS["--green"],
  red: CARD_TOKENS["--red"],
  blue: CARD_TOKENS["--blue"],
  ochre: CARD_TOKENS["--ochre"],
  ochreInk: CARD_TOKENS["--ochre-ink"],
  hilite: CARD_TOKENS["--hilite"],
} as const;

// The graph-paper line behind the card: the page's grid, ink at --grid-pct (6%) over transparent. It is the one
// transparent color, so it is not a :root token of its own; globals.contrast.test.ts derives it from --ink and --grid-pct.
export const CARD_GRID_LINE = "rgba(22,21,19,0.06)";
