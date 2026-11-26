import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { ImageResponse } from "next/og";
import { baselineLine, CARD_FOOTER, cardVerifyLine, nearMissLine, parseCardParams, type CardParams } from "@/lib/near";
import { C, CARD_GRID_LINE } from "./theme";

// Public endpoint: every input is validated by `parseCardParams` (digits and capital letters only,
// bounded, unknown parameters rejected so the shared cache cannot be bypassed), nothing is echoed back
// in an error, and the image is a fixed size. The scores in the URL are not checked against the chain:
// the card is a picture of what the link says, not a proof, and says so on the image.
//
// Fonts: Anton (display) and Work Sans (text) live in ./fonts (SIL Open Font License, see fonts/LICENSE.txt),
// read once per server process. A Next route file may export only handlers and config, so the size is private.

const WIDTH = 1200;
const HEIGHT = 630;

const FONT_FILES = [
  { name: "Anton", file: "anton-latin-400-normal.woff", weight: 400 },
  { name: "Work Sans", file: "work-sans-latin-400-normal.woff", weight: 400 },
  { name: "Work Sans", file: "work-sans-latin-700-normal.woff", weight: 700 },
] as const;

type CardFont = { name: string; data: Buffer; weight: 400 | 700; style: "normal" };
let fonts: Promise<CardFont[]> | undefined;
function loadFonts(): Promise<CardFont[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(
      async (f): Promise<CardFont> => ({
        name: f.name,
        data: await readFile(fileURLToPath(new URL(`./fonts/${f.file}`, import.meta.url))),
        weight: f.weight,
        style: "normal",
      }),
    ),
  ).catch((e: unknown) => {
    fonts = undefined; // do not cache a failure
    throw e;
  });
  return fonts;
}

const DISPLAY = "Anton";
const TEXT = "Work Sans";

type Child = string | ReactElement;
const h = (style: Record<string, string | number>, ...children: Child[]): ReactElement =>
  createElement("div", { style: { display: "flex", fontFamily: TEXT, ...style } }, ...children);

/** Three hatched candles (up, down, up) on a dashed baseline: decoration only, it carries no data. */
function candles(): ReactElement {
  const bodies = [
    { x: 40, y: 120, h: 70, up: true, hi: 90, lo: 215 },
    { x: 130, y: 130, h: 60, up: false, hi: 100, lo: 225 },
    { x: 220, y: 70, h: 100, up: true, hi: 40, lo: 200 },
  ];
  const hatch = (id: string, color: string, angle: number) =>
    createElement(
      "pattern",
      { key: id, id, width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: `rotate(${angle})` },
      createElement("rect", { key: "p", width: 8, height: 8, fill: C.card }),
      createElement("line", { key: "l", x1: 4, y1: -1, x2: 4, y2: 9, stroke: color, strokeWidth: 2.2 }),
    );
  return createElement(
    "svg",
    { width: 232, height: 152, viewBox: "0 30 290 190", xmlns: "http://www.w3.org/2000/svg" },
    createElement("defs", { key: "d" }, hatch("up", C.green, 45), hatch("down", C.red, -45)),
    createElement("line", { key: "base", x1: 8, y1: 150, x2: 282, y2: 150, stroke: C.muted, strokeWidth: 2, strokeDasharray: "7 6" }),
    ...bodies.flatMap((b, i) => [
      createElement("line", { key: `w${i}`, x1: b.x + 17, y1: b.hi, x2: b.x + 17, y2: b.lo, stroke: C.ink, strokeWidth: 2.5, strokeLinecap: "round" }),
      createElement("rect", {
        key: `b${i}`,
        x: b.x,
        y: b.y,
        width: 34,
        height: b.h,
        fill: `url(#${b.up ? "up" : "down"})`,
        stroke: C.ink,
        strokeWidth: 3,
        strokeLinejoin: "round",
      }),
    ]),
  );
}

function chip(label: string, score: number, edge: string, textColor: string): ReactElement {
  return h(
    {
      alignItems: "center",
      justifyContent: "space-between",
      width: 290,
      padding: "2px 16px 2px 14px",
      background: C.card,
      border: `3px solid ${C.ink}`,
      borderLeft: `14px solid ${edge}`,
      borderRadius: 10,
      boxShadow: `4px 4px 0 ${C.ink}`,
    },
    h({ fontSize: 24, fontWeight: 700, color: C.ink }, label),
    h({ fontFamily: DISPLAY, fontSize: 46, lineHeight: 1.1, color: textColor }, String(score)),
  );
}

function card(p: CardParams): ReactElement {
  const where = [p.ticker, p.round !== undefined ? `round #${p.round}` : undefined].filter(Boolean).join("  ");
  const win = p.me > p.agent;
  return h(
    {
      width: "100%",
      height: "100%",
      padding: "30px 46px 46px 30px",
      background: C.paper,
      backgroundImage: `linear-gradient(${CARD_GRID_LINE} 1px, transparent 1px), linear-gradient(90deg, ${CARD_GRID_LINE} 1px, transparent 1px)`,
      backgroundSize: "24px 24px",
    },
    h(
      {
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "26px 34px",
        background: C.card,
        color: C.ink,
        border: `4px solid ${C.ink}`,
        borderRadius: "28px 8px 24px 6px",
        boxShadow: `14px 14px 0 ${C.ink}`,
      },
      h(
        { flexShrink: 0, justifyContent: "space-between", alignItems: "flex-end", height: 48 },
        h({ fontFamily: DISPLAY, fontSize: 44, letterSpacing: 2, textTransform: "uppercase", lineHeight: 1.1 }, "Consensus Path"),
        h({ fontSize: 30, fontWeight: 700, color: C.muted }, where),
      ),
      h(
        { justifyContent: "space-between", alignItems: "center" },
        h(
          { flexDirection: "column" },
          h({ fontFamily: DISPLAY, fontSize: 150, lineHeight: 1.05, color: C.blue }, String(p.me)),
          h({ fontSize: 38, fontWeight: 700, lineHeight: 1.2, color: win ? C.green : C.ink }, nearMissLine(p.me, p.agent)),
          p.base !== undefined ? h({ fontSize: 26, lineHeight: 1.3, color: C.muted, marginTop: 6 }, baselineLine(p.me, p.base)) : h({}),
          h({ fontSize: 22, lineHeight: 1.3, color: C.muted, marginTop: 6 }, "Scores are 0..100. Moves are measured in basis points from P0."),
          h({ fontSize: 22, fontWeight: 700, lineHeight: 1.3, color: C.ochreInk, marginTop: 4 }, cardVerifyLine(p.round)),
        ),
        h(
          { flexDirection: "column", alignItems: "center", gap: 8 },
          chip("Human", p.me, C.blue, C.blue),
          chip("Agent", p.agent, C.ochre, C.ochreInk),
          candles(),
        ),
      ),
      h(
        { flexShrink: 0, fontSize: 18, lineHeight: 1.35, color: C.ink, background: C.hilite, border: `2px solid ${C.ink}`, borderRadius: 10, padding: "10px 14px" },
        CARD_FOOTER,
      ),
    ),
  );
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseCardParams(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return new Response("Invalid card parameters.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new ImageResponse(card(parsed.value), {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadFonts(),
    headers: { "cache-control": "public, max-age=3600, s-maxage=3600" },
  });
}
