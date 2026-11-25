import { createElement, type ReactElement } from "react";
import { ImageResponse } from "next/og";
import { baselineLine, CARD_FOOTER, cardVerifyLine, nearMissLine, parseCardParams, type CardParams } from "@/lib/near";

// Public endpoint: every input is validated by `parseCardParams` (digits and capital letters only,
// bounded, unknown parameters rejected so the shared cache cannot be bypassed), nothing is echoed back
// in an error, and the image is a fixed size. The scores in the URL are not checked against the chain:
// the card is a picture of what the link says, not a proof, and says so on the image.

const WIDTH = 1200;
const HEIGHT = 630;

const h = (style: Record<string, string | number>, ...children: (string | ReactElement)[]): ReactElement =>
  createElement("div", { style: { display: "flex", ...style } }, ...children);

function card(p: CardParams): ReactElement {
  const where = [p.ticker, p.round !== undefined ? `round #${p.round}` : undefined].filter(Boolean).join("  ");
  return h(
    {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: 56,
      background: "#0b0f17",
      color: "#e6ebf5",
    },
    h(
      { justifyContent: "space-between", fontSize: 32, color: "#8b97ad" },
      h({}, "Consensus Path"),
      h({}, where),
    ),
    h(
      { flexDirection: "column" },
      h({ fontSize: 170, fontWeight: 700, lineHeight: 1 }, String(p.me)),
      h({ fontSize: 48, color: p.me > p.agent ? "#22c55e" : "#e6ebf5" }, nearMissLine(p.me, p.agent)),
      p.base !== undefined ? h({ fontSize: 30, color: "#8b97ad", marginTop: 12 }, baselineLine(p.me, p.base)) : h({}),
      h({ fontSize: 24, color: "#8b97ad", marginTop: 12 }, "Scores are 0..100. Moves are measured in basis points from P0."),
      h({ fontSize: 24, color: "#f59e0b", marginTop: 8 }, cardVerifyLine(p.round)),
    ),
    h({ fontSize: 19, color: "#8b97ad", border: "2px solid #f59e0b", borderRadius: 12, padding: 14 }, CARD_FOOTER),
  );
}

export function GET(request: Request): Response | Promise<Response> {
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
    headers: { "cache-control": "public, max-age=3600, s-maxage=3600" },
  });
}
