import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_TOKENS } from "./api/card/theme";
import { DX, HANDLE_R, LEFT_X, P0_LABEL, SLOT_X } from "../components/DrawChart";
import { handleLabel } from "../lib/chartLabels";

// Reads the real stylesheet: if a token or a button color is changed to something too faint, this fails.
//
// LIMITS of the tiny CSS parser below: it ignores @media wrappers (rules inside a media block are read as if
// they were unconditional) and it does not model specificity or the cascade beyond "later wins in the order
// the caller lists selectors". So text/background colors must NOT be set inside any @media block (a guard test
// below fails if they are), and anything this file asserts about an element is asserted on the selector chain
// the test names, not on what a browser would compute for every DOM nesting.
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; decls: Map<string, string> };

function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of (m[2] as string).split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    rules.push({ selectors: (m[1] as string).split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls });
  }
  return rules;
}

const rules = parseRules(css);

// What counts as a color literal in a component: a quoted (or `prop: `) #rgb, #rgba, #rrggbb, #rrggbbaa, or a color
// function. Plain text such as "Round #123" or `url(#id)` is not a color.
const HEX_LITERAL = /(?:[\"'`]|:\s*)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\(/;

/** Declarations that apply to `selectors` merged in source order (later wins; specificity is not modeled). */
function effective(...selectors: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const sel of selectors) {
    for (const r of rules) {
      if (r.selectors.includes(sel)) for (const [k, v] of r.decls) out.set(k, v);
    }
  }
  return out;
}

const tokens = new Map<string, string>();
for (const [k, v] of effective(":root")) if (k.startsWith("--")) tokens.set(k, v);

function resolve(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref) return resolve(tokens.get(ref[1] as string));
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  return undefined;
}

function token(name: string): string {
  const v = resolve(`var(${name})`);
  if (!v) throw new Error(`token ${name} is not a literal hex color in :root`);
  return v;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Color of a 1px grid line: ink at --grid-pct over paper (the worst spot for text on the page). */
function gridLine(): string {
  const pct = Number(/^(\d+(?:\.\d+)?)%$/.exec(tokens.get("--grid-pct") ?? "")?.[1]) / 100;
  const [p, i] = [rgb(token("--paper")), rgb(token("--ink"))];
  const mixed = p.map((c, k) => Math.round(c * (1 - pct) + (i[k] as number) * pct));
  return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function check(label: string, fg: string, bg: string, min: number) {
  expect(ratio(fg, bg), `${label}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
}

/** Bodies of every @media block (brace matched), so the guard below can inspect what they declare. */
function mediaBodies(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/@media[^{]*\{/g)) {
    let depth = 1;
    let i = (m.index as number) + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe("palette contrast (WCAG 2.x)", () => {
  const paper = token("--paper");
  const card = token("--card");
  const grid = gridLine();

  it("ink and muted ink read on paper, on the grid lines and on cards", () => {
    check("ink on paper", token("--ink"), paper, 7);
    check("ink on grid line", token("--ink"), grid, 7);
    check("ink on card", token("--ink"), card, 7);
    check("muted on paper", token("--muted"), paper, 4.5);
    check("muted on grid line", token("--muted"), grid, 4.5);
    check("muted on card", token("--muted"), card, 4.5);
  });

  it("semantic text colors read on card and paper", () => {
    for (const name of ["--green", "--red", "--blue", "--ochre-ink"]) {
      check(`${name} text on card`, token(name), card, 4.5);
      check(`${name} text on paper`, token(name), paper, 4.5);
    }
  });

  it("disclaimer surfaces keep ink text strong", () => {
    const notice = effective(".notice");
    const sim = effective(".sim-label");
    check(".notice text", resolve(notice.get("color")) as string, resolve(notice.get("background")) as string, 7);
    check(".sim-label text", resolve(sim.get("color")) as string, resolve(sim.get("background")) as string, 7);
    expect(notice.get("border")).toMatch(/2px solid/);
  });

  it("text on every button variant", () => {
    const variants: [string, string[]][] = [
      [".btn", [".btn"]],
      [".btn.primary", [".btn", ".btn.primary"]],
      [".btn.warn", [".btn", ".btn.warn"]],
      [".btn disabled", [".btn", ".btn:disabled"]],
      [".btn.primary disabled", [".btn", ".btn.primary", ".btn.primary:disabled"]],
    ];
    for (const [label, chain] of variants) {
      const d = effective(...chain);
      const fg = resolve(d.get("color"));
      const bg = resolve(d.get("background"));
      expect(fg, `${label} color`).toBeDefined();
      expect(bg, `${label} background`).toBeDefined();
      check(`button ${label}`, fg as string, bg as string, 4.5);
    }
    // Ghost has a transparent background: its ink text sits on the page or on a card.
    const ghost = effective(".btn", ".btn.ghost");
    expect(ghost.get("background")).toBe("transparent");
    const ghostFg = resolve(ghost.get("color")) as string;
    check("button .btn.ghost on paper", ghostFg, paper, 4.5);
    check("button .btn.ghost on grid line", ghostFg, grid, 4.5);
    check("button .btn.ghost on card", ghostFg, card, 4.5);
  });

  it("small labels and tracker steps", () => {
    for (const [label, chain] of [
      [".tag", [".tag"]],
      [".tag.sim on card", [".tag", ".tag.sim"]],
      [".tracker li", [".tracker li"]],
      [".tracker li.done", [".tracker li", ".tracker li.done"]],
      [".tracker li.current", [".tracker li", ".tracker li.current"]],
    ] as [string, string[]][]) {
      const d = effective(...chain);
      const bg = resolve(d.get("background")) ?? card;
      check(label, resolve(d.get("color")) as string, bg, 4.5);
    }
    check(".tracker closing on current", resolve(effective(".tracker li .closing").get("color")) as string, token("--ink"), 4.5);
  });

  it("side highlights keep their text readable", () => {
    const tint = (hex: string, pct: number) => {
      const [a, b] = [rgb(card), rgb(hex)];
      return "#" + a.map((c, k) => Math.round(c * (1 - pct) + (b[k] as number) * pct).toString(16).padStart(2, "0")).join("");
    };
    // The highlight color and its share are read from the color-mix() in the stylesheet, not repeated here.
    const highlight = (selector: string) => {
      const m = /color-mix\(\s*in srgb\s*,\s*var\((--[\w-]+)\)\s+(\d+(?:\.\d+)?)%/.exec(effective(selector).get("box-shadow") ?? "");
      if (!m) throw new Error(`${selector} has no color-mix() highlight in box-shadow`);
      return { base: token(m[1] as string), pct: Number(m[2]) / 100 };
    };
    for (const [selector, textToken] of [
      [".tag-side.human", "--blue"],
      [".tag-side.agent", "--ochre-ink"],
    ] as const) {
      const { base, pct } = highlight(selector);
      expect(pct, `${selector} highlight share`).toBeGreaterThan(0);
      check(`${selector} text on its ${pct * 100}% highlight`, token(textToken), tint(base, pct), 4.5);
    }
  });

  it("non-text marks are distinguishable (3:1) against the chart card", () => {
    // Raw ochre is a highlighter fill (2.4:1 on the card): every ochre mark carries an ink outline, and an
    // ochre-only line (a chart stroke) must use --ochre-ink instead.
    for (const name of ["--blue", "--ochre-ink", "--tie", "--green", "--red", "--ink"]) check(`${name} mark on card`, token(name), card, 3);
    for (const sel of [".mk-agent", ".tag", ".swatch"]) {
      expect(effective(sel).get("stroke") ?? effective(sel).get("border"), `${sel} needs an ink outline`).toMatch(/var\(--ink\)/);
    }
  });

  it("the ink outline stays visible on the tinted candle bodies", () => {
    check("ink on green tint", token("--ink"), token("--green-tint"), 7);
    check("ink on red tint", token("--ink"), token("--red-tint"), 7);
    check("ink on ochre tag", token("--ink"), token("--ochre"), 4.5);
  });

  it("prints the ratios when CONTRAST_REPORT is set", () => {
    // Self-contained: computes its own pairs, so it passes alone (-t) and does not depend on test order.
    const pairs: [string, string, string, number][] = [
      ["ink on paper", token("--ink"), paper, 7],
      ["muted on card", token("--muted"), card, 4.5],
      ["blue on card", token("--blue"), card, 4.5],
      ["ochre-ink on card", token("--ochre-ink"), card, 4.5],
    ];
    const lines = pairs.map(([label, fg, bg, min]) => {
      const r = ratio(fg, bg);
      expect(r, label).toBeGreaterThanOrEqual(min);
      return `${r.toFixed(2).padStart(6)}  (min ${min})  ${label}  ${fg} on ${bg}`;
    });
    if (process.env.CONTRAST_REPORT) console.log(lines.join("\n"));
    expect(lines).toHaveLength(pairs.length);
  });

  it("no @media block sets a text or background color (the parser would read it as unconditional)", () => {
    const blocks = mediaBodies(css);
    expect(blocks.length, "the stylesheet has @media blocks to guard").toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const body of blocks) {
      for (const r of parseRules(body)) {
        for (const prop of r.decls.keys()) {
          if (prop === "color" || prop.startsWith("background")) offenders.push(`${r.selectors.join(", ")} { ${prop} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("explanatory text never uses the hand face (it is for short annotations only)", () => {
    const chains: [string, string[]][] = [
      [".hint", [".hint"]],
      [".wallet-wrap .hint", [".hint", ".wallet-wrap .hint"]],
      [".wallet-menu .hint", [".hint", ".wallet-menu .hint"]],
      [".notice", [".notice"]],
      [".sim-label", [".sim-label"]],
      [".muted", [".muted"]],
    ];
    for (const [label, chain] of chains) {
      const d = effective(...chain);
      expect(d.get("font-family") ?? "", `${label} font-family`).not.toContain("--f-hand");
      const size = d.get("font-size");
      if (size !== undefined) {
        const rem = /^(\d+(?:\.\d+)?)rem$/.exec(size);
        expect(rem, `${label} font-size ${size} is in rem`).not.toBeNull();
        expect(Number(rem?.[1]), `${label} font-size`).toBeGreaterThanOrEqual(0.9);
      }
    }
    // The long-form disclosure classes name the body face explicitly instead of inheriting it by luck.
    for (const sel of [".hint", ".notice", ".sim-label", ".muted"]) {
      expect(effective(sel).get("font-family"), `${sel} font-family`).toBe("var(--f-body)");
    }
  });

  it("stage 2 surfaces keep their text readable", () => {
    const hilite = token("--hilite");
    const house = effective(".card.house");
    const houseBg = resolve(house.get("background")) as string;
    expect(houseBg, ".card.house has a literal background").toBeDefined();
    check("ink on the house sheet", token("--ink"), houseBg, 7);
    check("muted on the house sheet", token("--muted"), houseBg, 4.5);
    check("sticker label and ring text (ink) on the stamp disc", token("--ink"), resolve(effective(".doodle-sticker .sticker-disc").get("fill")) as string, 7);
    check("checked bet side (ink) on its highlight", token("--ink"), resolve(effective(".bet-form label.radio:has(input:checked)").get("background")) as string, 7);
    check("wallet address tag (ink) on its highlight", token("--ink"), resolve(effective(".wallet .addr").get("background")) as string, 7);
    check("hilite is the sticker, side and address highlight", token("--ink"), hilite, 7);
    check("notice lead word on the notice highlight", token("--ink"), token("--hilite-soft"), 7);
    // Score colors in the reveal table sit on the card.
    check("human score blue on card", resolve(effective(".reveal [data-score-human]").get("color")) as string, card, 4.5);
    check("agent score ochre-ink on card", resolve(effective(".reveal [data-score-agent]").get("color")) as string, card, 4.5);
  });

  it("doodles never take clicks, and every animation lives in the no-preference media block", () => {
    expect(effective(".doodle").get("pointer-events")).toBe("none");
    expect(effective(".sticker-wrap").get("pointer-events")).toBe("none");
    expect(effective(".note-row").get("pointer-events")).toBe("none");
    // Strip every @media block: what remains is the static (reduced motion) stylesheet and must not animate.
    let rest = css;
    for (const body of mediaBodies(css)) rest = rest.replace(body, "");
    expect(rest, "no animation outside @media").not.toMatch(/(^|[\s;{])animation(-[a-z-]+)?\s*:/);
    expect(rest, "no @keyframes outside @media").not.toMatch(/@keyframes/);
    const motion = mediaBodies(css).find((b) => b.includes("@keyframes")) ?? "";
    expect(mediaBodies(css).some((b) => b.includes("@keyframes") && b.includes("animation")), "keyframes and animations share a block").toBe(true);
    // Every animation duration except the slow ring is under about 600ms.
    const timed = [...motion.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)(m?s)/g)];
    expect(timed.length, "durations were parsed").toBeGreaterThanOrEqual(5);
    for (const m of timed) {
      const ms = m[3] === "s" ? Number(m[2]) * 1000 : Number(m[2]);
      if (m[1] !== "ring-spin") expect(ms, `${m[1]} duration`).toBeLessThanOrEqual(600);
    }
  });

  it("the dashboard table scrolls inside a wrapper instead of being display:block", () => {
    expect(effective(".dash-table").get("display")).toBeUndefined();
    expect(effective(".table-scroll").get("overflow-x")).toBe("auto");
  });

  it("wallet error text is at least 0.9rem", () => {
    const rem = /^(\d+(?:\.\d+)?)rem$/.exec(effective(".wallet-wrap .error").get("font-size") ?? "");
    expect(rem).not.toBeNull();
    expect(Number(rem?.[1])).toBeGreaterThanOrEqual(0.9);
  });

  it("every stroke token used by a chart mark is distinguishable (3:1) on the card", () => {
    // Strokes in the stylesheet that name a token: lines, outlines, hatch strokes and leader lines.
    const seen = new Set<string>();
    for (const r of rules) {
      const stroke = r.decls.get("stroke");
      if (stroke === undefined || /^(none|transparent|currentColor)$/i.test(stroke)) continue;
      const hex = resolve(stroke);
      expect(hex, `${r.selectors.join(", ")} stroke ${stroke} resolves to a token`).toBeDefined();
      check(`${r.selectors.join(", ")} stroke`, hex as string, card, 3);
      seen.add(r.selectors.join(", "));
    }
    for (const sel of [".hatch-up line", ".hatch-down line", ".chart .leader", ".chart .mark", ".chart .baseline"]) {
      expect(seen.has(sel), `${sel} has a checked stroke`).toBe(true);
    }
    // Series lines take their color from tokens in PathChart: human blue and agent ochre ink.
    check("--c-human line", resolve("var(--c-human)") as string, card, 3);
    check("--c-agent-ink line", resolve("var(--c-agent-ink)") as string, card, 3);
    // The hatch strokes lie on card-colored paper.
    expect(resolve(effective(".hatch-paper").get("fill"))).toBe(card);
  });

  it("candle hatching uses opposite directions for up and down (not color alone)", () => {
    const src = readFileSync(join(__dirname, "..", "components", "ChartHatch.tsx"), "utf8");
    expect(src).toMatch(/hatch-up[^>]*rotate\(45\)/);
    expect(src).toMatch(/hatch-down[^>]*rotate\(-45\)/);
  });

  it("the chart axis labels stay clear of candle 1's high handle at the default flat path", () => {
    // Geometry comes from DrawChart itself: the P0 label starts at LEFT_X, candle 1's high handle's left edge is
    // SLOT_X[0] + DX.high - HANDLE_R. Widths are estimated per character: 0.6em for the body face, 0.45em for the narrow hand face.
    const px = /^(\d+(?:\.\d+)?)px$/.exec(effective(".chart .axis").get("font-size") ?? "");
    expect(px, ".chart .axis font-size in px").not.toBeNull();
    const size = Number(px?.[1]);
    const end = LEFT_X + P0_LABEL.length * 0.6 * size;
    const handleLeft = (SLOT_X[0] as number) + DX.high - HANDLE_R;
    expect(end, "P0 label right edge in SVG units").toBeLessThanOrEqual(handleLeft - 12);
    // It must also stay left of the hand-written "high" label of candle 1 (its text runs left from its anchor).
    const high = handleLabel("high", (SLOT_X[0] as number) + DX.high, 160, HANDLE_R, 320);
    const noteSize = Number(/^(\d+(?:\.\d+)?)px$/.exec(effective(".chart .chart-note").get("font-size") ?? "")?.[1]);
    expect(noteSize).toBeGreaterThan(0);
    expect(high.tx - "high".length * 0.45 * noteSize, "high note left edge").toBeGreaterThan(end);
  });

  it("chart text is at least 10px on a 360px phone", () => {
    // The chart svg is 520 units wide and about 308px wide on a 360px phone (page and card padding, borders).
    const scale = 308 / 520;
    for (const sel of [".chart .axis", ".chart .chart-note", ".trend .trend-axis"]) {
      const px = Number(/^(\d+(?:\.\d+)?)px$/.exec(effective(sel).get("font-size") ?? "")?.[1]);
      // the trend chart is 560 wide
      const s = sel.startsWith(".trend") ? 308 / 560 : scale;
      expect(px * s, `${sel} effective px`).toBeGreaterThanOrEqual(9.9);
    }
  });

  it("the hand face in charts is limited to the short handle notes", () => {
    expect(effective(".chart .chart-note").get("font-family")).toBe("var(--f-hand)");
    for (const sel of [".chart .axis", ".trend .trend-axis"]) expect(effective(sel).get("font-family")).toBe("var(--f-body)");
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && readFileSync(full, "utf8").includes("chart-note")) users.push(name);
      }
    };
    walk(join(__dirname, ".."));
    expect(users).toEqual(["DrawChart.tsx"]);
  });

  it("no TSX component writes a color literal: colors come from the stylesheet tokens", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) {
          readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
            if (HEX_LITERAL.test(line) || COLOR_FN.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
  });

  it("the share card colors equal the stylesheet tokens they copy", () => {
    for (const [name, hex] of Object.entries(CARD_TOKENS)) expect(hex, name).toBe(token(name));
    // The card is light paper: its text pairs hold the same ratios as on the site.
    check("card ink on card", CARD_TOKENS["--ink"], CARD_TOKENS["--card"], 7);
    check("card muted on card", CARD_TOKENS["--muted"], CARD_TOKENS["--card"], 4.5);
    check("card ink on footer highlight", CARD_TOKENS["--ink"], CARD_TOKENS["--hilite"], 7);
    for (const name of ["--green", "--blue", "--ochre-ink"] as const) check(`card ${name} text on card`, CARD_TOKENS[name], CARD_TOKENS["--card"], 4.5);
  });

  it("the harness itself: a faint color is rejected, a color literal is caught", () => {
    for (const bad of ['const c = "#3b82f6";', "fill: '#fff'", 'stroke="#a78bfa80"', "color: rgb(1, 2, 3)"]) {
      expect(HEX_LITERAL.test(bad) || COLOR_FN.test(bad), bad).toBe(true);
    }
    for (const ok of ['fill="url(#hatch-up-r1)"', "Round #123", 'style={{ stroke: "var(--c-human)" }}']) {
      expect(HEX_LITERAL.test(ok) || COLOR_FN.test(ok), ok).toBe(false);
    }
    expect(ratio("#c9c3b4", "#f6f1e4")).toBeLessThan(4.5);
    expect(ratio("#161513", "#ffffff")).toBeGreaterThan(15);
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
