import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_GRID_LINE, CARD_TOKENS } from "./api/card/theme";
import { DX, HANDLE_R, LEFT_X, P0_LABEL, SLOT_X } from "../components/DrawChart";
import { handleLabel } from "../lib/chartLabels";

// Reads the real stylesheet: if a token or a button color is changed to something too faint, this fails.
//
// LIMITS of the tiny CSS parser below: `rules` ignores @media wrappers (rules inside a media block are read as if
// they were unconditional) and it does not model specificity or the cascade beyond "later wins in the order
// the caller lists selectors". So colors must NOT be set inside any @media block (a guard test below fails if
// they are), and anything this file asserts about an element is asserted on the selector chain the test names,
// not on what a browser would compute for every DOM nesting. `parseTree` keeps the @media / @keyframes ancestry
// of every rule and is used by the motion guards.
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

// What counts as a color literal in a component or a lib file (see hasColorLiteral): a #rgb, #rgba, #rrggbb or
// #rrggbbaa after a quote, a space, `:`, `=` or `,` (so `"1px solid #a78bfa"` is caught; `url(#id)` is not), a color
// function (rgb, hsl, oklch ...), or a named color in a color property (`fill="red"`, `border: "1px solid black"`)
// or as a whole string (`"white"`). Plain text such as "Round #123" is not a color.
const HEX_LITERAL = /(^|[\s"'`:=,])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
// A digit-only #123 or #1234 is a color when the character right before the # is a quote, `:`, `=` or `,`, or when it
// follows a border style (`solid #000`), a CSS length (`0 0 0 #123`) or a color property (`color: #333`, `boxShadow: "2px 2px 0 #555"`). After plain
// whitespace in prose ("Round #123") it is a number sign.
const COLOR_CONTEXT =
  /(?:\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\s+|\b\d+(?:\.\d+)?(?:px|r?em|%)?\s+$|\b(?:fill|stroke|color|background(?:Color|Image)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|boxShadow|textShadow|stopColor|floodColor|caretColor|accentColor|[\w-]*-color)\s*[:=][^#]*)$/;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color|color-mix)\(/;
const NAMED_COLORS = (
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
  "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
  "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
  "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
  "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
  "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
  "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
  "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
  "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
  "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver " +
  "skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
  "whitesmoke yellow yellowgreen"
).split(" ");
const NAMED_WORD = new RegExp(`\\b(?:${NAMED_COLORS.join("|")})\\b`, "i");
const NAMED_WHOLE = new RegExp(`["'\`](?:${NAMED_COLORS.join("|")})["'\`]`, "i");
const COLOR_PROP_VALUE =
  /\b(?:fill|stroke|color|background(?:Color|Image)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|boxShadow|textShadow|stopColor|floodColor|caretColor|accentColor)\b\s*[:=]\s*\{?\s*["'`]([^"'`]*)["'`]/g;

/** True when `line` of TS or TSX source writes a color literal instead of taking it from a stylesheet token. */
function hasColorLiteral(line: string): boolean {
  for (const m of line.matchAll(HEX_LITERAL)) {
    const [before, hex] = [m[1] as string, m[2] as string];
    const prefix = line.slice(0, (m.index as number) + before.length);
    // "Round #123": a number sign in prose, not a color; every other context decides for a color
    if (/^\d{3,4}$/.test(hex) && !/["'`:=,]/.test(before) && !COLOR_CONTEXT.test(prefix)) continue;
    return true;
  }
  if (COLOR_FN.test(line) || NAMED_WHOLE.test(line)) return true;
  for (const m of line.matchAll(COLOR_PROP_VALUE)) if (NAMED_WORD.test(m[1] as string)) return true;
  return false;
}

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

/** `fg` at opacity `alpha` over `bg`, as a #rrggbb color (channels rounded like a browser does). */
function blend(fg: string, bg: string, alpha: number): string {
  const [f, b] = [rgb(fg), rgb(bg)];
  return "#" + f.map((c, k) => Math.round(c * alpha + (b[k] as number) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

/** Strokes that are decoration only (the information is in the labels and the zero line): see the stroke test. */
const DECORATIVE_STROKES = new Set([".trend .trend-grid"]);

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

// ---- Structure-aware parsing for the motion, @media and font guards ----

const MOTION_QUERY = "@media (prefers-reduced-motion: no-preference)";

type Node = { kind: "rule" | "keyframes" | "frame"; prelude: string; body: string; ancestors: string[]; decls: Map<string, string> };

function declsOf(body: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return decls;
}

/** Every rule, @keyframes block and keyframe step of `source`, each with the at-rules (@media, @keyframes) around it. */
function parseTree(source: string, ancestors: string[] = []): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    const prelude = source.slice(i, open).trim().replace(/\s+/g, " ");
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") depth--;
      j++;
    }
    const body = source.slice(open + 1, j - 1);
    if (/^@(media|supports)\b/.test(prelude)) {
      out.push(...parseTree(body, [...ancestors, prelude]));
    } else if (/^@keyframes\b/.test(prelude)) {
      out.push({ kind: "keyframes", prelude, body, ancestors, decls: new Map() });
      for (const step of parseTree(body, [...ancestors, prelude])) out.push({ ...step, kind: "frame" });
    } else {
      out.push({ kind: "rule", prelude, body, ancestors, decls: declsOf(body) });
    }
    i = j;
  }
  return out;
}

/** Splits on `sep` (a character, or any whitespace for " ") outside parentheses; empty parts are dropped. */
function splitTop(value: string, sep: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function toMs(token: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(token);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : undefined;
}

const MAX_MOTION_MS = 600; // one animation or transition lasts at most this long (and so does its delay)
const MAX_ITERATIONS = 3; // nothing repeats for more than a few cycles (WCAG 2.2.2: nothing moves on for 5 s)
const MAX_TOTAL_MS = 1500; // delay + duration * iterations

/**
 * Everything wrong with the motion in `source`: an animation, transition or @keyframes outside
 * `@media (prefers-reduced-motion: no-preference)`, an `infinite` loop, a duration or delay over 600 ms (shorthand
 * and longhand), an iteration count over 3, or a total over 1.5 s. `timed` counts the parsed `animation` shorthands.
 */
function motionProblems(source: string): { problems: string[]; timed: number } {
  const problems: string[] = [];
  let timed = 0;
  if (/\binfinite\b/.test(source)) problems.push("`infinite` appears in the stylesheet");
  for (const n of parseTree(source)) {
    const moves = n.kind === "keyframes" || /animation|transition|@keyframes/.test(n.body);
    if (moves && !n.ancestors.includes(MOTION_QUERY)) problems.push(`${n.prelude} moves outside ${MOTION_QUERY}`);
    if (n.kind === "keyframes") continue;
    for (const [prop, value] of n.decls) {
      const where = `${n.prelude} { ${prop}: ${value} }`;
      const over = (ms: number | undefined, what: string) => {
        if (ms === undefined) problems.push(`${where}: ${what} is not a plain time`);
        else if (ms > MAX_MOTION_MS) problems.push(`${where}: ${what} ${ms} ms is over ${MAX_MOTION_MS} ms`);
      };
      if (prop === "animation" || prop === "transition") {
        for (const item of splitTop(value, ",")) {
          const tokens = splitTop(item, " ");
          // a var() anywhere in the shorthand may hold a time (or a count) the checks below cannot read
          if (tokens.some((t) => t.includes("var("))) problems.push(`${where}: a var() in the shorthand is not a plain time`);
          const times = tokens.map(toMs).filter((t): t is number => t !== undefined);
          const [duration = 0, delay = 0] = times;
          over(duration, "duration");
          over(delay, "delay");
          if (prop === "animation") {
            timed++;
            const count = Number(tokens.find((t) => /^\d+(\.\d+)?$/.test(t)) ?? 1);
            if (count > MAX_ITERATIONS) problems.push(`${where}: ${count} iterations`);
            if (delay + duration * count > MAX_TOTAL_MS) problems.push(`${where}: runs longer than ${MAX_TOTAL_MS} ms in all`);
          }
        }
      } else if (/^(animation|transition)-(duration|delay)$/.test(prop)) {
        for (const item of splitTop(value, ",")) over(toMs(item), prop.split("-")[1] as string);
      } else if (prop === "animation-iteration-count") {
        for (const item of splitTop(value, ",")) {
          if (!(Number(item) <= MAX_ITERATIONS)) problems.push(`${where}: iteration count ${item}`);
        }
      }
    }
  }
  return { problems, timed };
}

/** `value` with each `var(--x, fallback)` replaced by `vars[--x]` or its fallback (the fallbacks here hold no parentheses). */
function substituteVars(value: string, vars: Record<string, string>): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_all, name: string, fallback: string | undefined) => vars[name] ?? fallback ?? "");
}

/**
 * Selectors that a rule applies `animation: <name> ...` to whose static transform (the base chain `base` plus that
 * selector, later wins) differs from the transform at step `at` of `@keyframes <name>`, with `vars` substituted into
 * both. With `both` the animation's last step holds, and with reduced motion only the static transform shows, so an
 * empty list means the finished animation and the static state look the same on every element it runs on.
 */
function keyframeEndMismatches(source: string, name: string, at: string, base: string[], vars: Record<string, string> = {}): string[] {
  const nodes = parseTree(source);
  const end = nodes.find((n) => n.kind === "frame" && n.ancestors.includes(`@keyframes ${name}`) && n.prelude === at)?.decls.get("transform");
  if (end === undefined) return [`@keyframes ${name} ${at} has no transform`];
  const staticOf = (sel: string) => {
    const out = new Map<string, string>();
    for (const s of [...base, sel]) {
      for (const n of nodes) if (n.kind === "rule" && n.prelude.split(",").map((x) => x.trim()).includes(s)) for (const [k, v] of n.decls) out.set(k, v);
    }
    return out.get("transform") ?? "none";
  };
  const runs = (n: Node) => splitTop(n.decls.get("animation") ?? "", ",").some((a) => splitTop(a, " ")[0] === name);
  const selectors = nodes.filter((n) => n.kind === "rule" && runs(n)).flatMap((n) => n.prelude.split(",").map((x) => x.trim()));
  if (selectors.length === 0) return [`no rule animates ${name}`];
  // identity steps (rotate(0deg), scaleX(1), scale(1)) draw nothing, so `none` and `rotate(0deg) scaleX(1)` are the same state
  const shown = (t: string) => substituteVars(t, vars).replace(/\b(?:rotate\(0(?:deg)?\)|scaleX?\(1\))/g, "").replace(/\s+/g, " ").trim() || "none";
  return selectors.filter((sel) => shown(staticOf(sel)) !== shown(end));
}

const COLOR_PROPS = /^(?:color|background(?:-[a-z-]+)?|--[\w-]+|fill|stroke|border(?:-[a-z]+)?-color|outline-color|text-decoration-color|caret-color|accent-color)$/;

/** Color-carrying declarations (including custom properties) that sit inside an @media block. */
function mediaColorOffenders(source: string): string[] {
  const out: string[] = [];
  for (const n of parseTree(source)) {
    if (n.kind === "keyframes" || !n.ancestors.some((a) => a.startsWith("@media"))) continue;
    for (const prop of n.decls.keys()) if (COLOR_PROPS.test(prop)) out.push(`${n.prelude} { ${prop} }`);
  }
  return out;
}

// The only selectors that may use the hand face (--f-hand): the annotation class and the in-chart note.
const HAND_SELECTORS = new Set([".note-hand", ".chart-note", ".chart .chart-note"]);

/** Any way to name the hand face: the token, the next/font variable behind it, or the family itself. */
const HAND_FACE = /--f-hand|--font-hand|\bCaveat\b/i;

/**
 * Rules anywhere in the stylesheet whose declarations name the hand face (`--f-hand`, `var(--font-hand)`, `Caveat`) but
 * whose selector is not exactly an allowed one. The one place that may define the face is `:root { --f-hand: ... }`.
 */
function handFontOffenders(source: string): string[] {
  const out: string[] = [];
  for (const n of parseTree(source)) {
    if (n.kind === "keyframes") continue;
    const uses = [...n.decls].some(([prop, v]) => HAND_FACE.test(v) && !(n.prelude === ":root" && prop === "--f-hand"));
    if (uses && !HAND_SELECTORS.has(n.prelude)) out.push(n.prelude);
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
    expect(mediaBodies(css).length, "the stylesheet has @media blocks to guard").toBeGreaterThan(0);
    // text and background colors, custom properties (--*), fill, stroke and border colors
    expect(mediaColorOffenders(css)).toEqual([]);
  });

  it("the @media color guard sees color, background, custom properties, fill, stroke and border-color", () => {
    const bad = (decl: string) => mediaColorOffenders(`@media (max-width: 1px) { .x { ${decl} } }`);
    for (const decl of ["color: red", "background: red", "background-color: red", "--c: #fff", "fill: red", "stroke: red", "border-color: red", "border-top-color: red"]) {
      expect(bad(decl), decl).toHaveLength(1);
    }
    for (const decl of ["padding: 1px", "stroke-width: 2", "stroke-dasharray: 2", "border-style: dashed", "font-size: 1rem"]) {
      expect(bad(decl), decl).toEqual([]);
    }
    expect(mediaColorOffenders(".x { color: red }")).toEqual([]); // outside @media is the normal place
    // nested inside the motion query too
    expect(mediaColorOffenders(`${MOTION_QUERY} { @keyframes k { to { fill: red } } }`)).toHaveLength(1);
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

  it("doodles never take clicks", () => {
    expect(effective(".doodle").get("pointer-events")).toBe("none");
    expect(effective(".sticker-wrap").get("pointer-events")).toBe("none");
    expect(effective(".note-row").get("pointer-events")).toBe("none");
  });

  it("all motion lives under prefers-reduced-motion: no-preference and is short, finite and parsed", () => {
    // Every rule or @keyframes block that animates or transitions must sit under the no-preference query; durations
    // and delays (shorthand and longhand) are at most 600 ms, nothing loops, so nothing moves on for 5 s (WCAG 2.2.2).
    const { problems, timed } = motionProblems(css);
    expect(problems).toEqual([]);
    expect(timed, "animation shorthands were parsed").toBeGreaterThanOrEqual(5);
    const nodes = parseTree(css);
    expect(nodes.filter((n) => n.kind === "keyframes").length, "keyframes exist").toBeGreaterThanOrEqual(5);
    expect(nodes.some((n) => [...n.decls.keys()].some((k) => k === "animation-duration")), "a longhand duration is present").toBe(true);
  });

  it("the motion guard itself catches loops, long durations, longhands and motion outside the query", () => {
    const inMotion = (body: string) => `${MOTION_QUERY} { ${body} }`;
    const bad: [string, string][] = [
      ["infinite shorthand", inMotion(".x { animation: spin 0.5s linear infinite }")],
      ["infinite longhand", inMotion(".x { animation-iteration-count: infinite }")],
      ["long shorthand", inMotion(".x { animation: a 1.2s ease-out }")],
      ["long longhand duration", inMotion(".x { animation-duration: 2s }")],
      ["long longhand delay", inMotion(".x { animation-delay: 700ms }")],
      ["long transition", inMotion(".x { transition: transform 1s ease }")],
      ["long transition longhand", inMotion(".x { transition-duration: 0.9s }")],
      ["many iterations", inMotion(".x { animation: a 0.5s ease 4 }")],
      ["too long in all", inMotion(".x { animation: a 0.5s ease 0.6s 3 }")],
      ["not a plain time", inMotion(".x { animation-duration: var(--d) }")],
      ["var in animation shorthand", inMotion(".x { animation: a var(--d) }")],
      ["var after a plain time in animation", inMotion(".x { animation: a 0.5s ease var(--n) }")],
      ["var in transition shorthand", inMotion(".x { transition: transform var(--d) ease }")],
      ["var in a later transition item", inMotion(".x { transition: opacity 0.1s, transform 0.1s var(--e) }")],
      ["animation outside", ".x { animation: a 0.1s }"],
      ["longhand outside", ".x { animation-duration: 0.1s }"],
      ["transition outside", ".x { transition: transform 0.1s }"],
      ["keyframes outside", "@keyframes k { to { opacity: 1 } }"],
      ["wrong query", "@media (prefers-reduced-motion: reduce) { .x { animation: a 0.1s } }"],
      ["other media", "@media (max-width: 420px) { .x { transition: transform 0.1s } }"],
    ];
    for (const [label, sheet] of bad) expect(motionProblems(sheet).problems.length, label).toBeGreaterThan(0);
    const good = inMotion("@keyframes k { to { opacity: 1 } } .x { animation: k 0.35s cubic-bezier(0.2, 0.8, 0.3, 1.15) 0.15s both; transition: transform 0.12s ease-out, box-shadow 0.12s ease-out } .y { animation-duration: 300ms; animation-iteration-count: 2 }");
    expect(motionProblems(good)).toEqual({ problems: [], timed: 1 });
  });

  it("the end of every transform animation equals the static transform, so the finished drawing keeps its tilt", () => {
    const nodes = parseTree(css);
    const step = (name: string, at: string) => nodes.find((n) => n.kind === "frame" && n.ancestors.includes(`@keyframes ${name}`) && n.prelude === at);
    const stat = effective(".doodle").get("transform");
    expect(stat).toBe("rotate(var(--rot, 0deg)) scaleX(var(--flip, 1))");
    // pop-in (score sparkle rotate(10deg), circles) and the hover wiggle end where the static rule stands
    expect(step("doodle-pop", "to")?.decls.get("transform")).toBe(stat);
    // ... on every element it runs on, not only on .doodle: each selector's own static transform must match too
    for (const vars of [{}, { "--rot": "12deg", "--flip": "-1" }] as Record<string, string>[]) {
      expect(keyframeEndMismatches(css, "doodle-pop", "to", [".doodle"], vars), `doodle-pop end vs static ${JSON.stringify(vars)}`).toEqual([]);
      expect(keyframeEndMismatches(css, "wiggle", "0%, 100%", [".doodle"], vars), `wiggle end vs static ${JSON.stringify(vars)}`).toEqual([]);
    }
    expect(step("wiggle", "0%, 100%")?.decls.get("transform")).toBe(stat);
    // the stamp ends at the sticker's own tilt; the ring turn ends at no transform
    expect(step("stamp", "100%")?.decls.get("transform")).toBe("rotate(var(--tilt, -7deg)) scale(1)");
    expect(effective(".doodle-sticker").get("transform")).toBe("rotate(var(--tilt, -7deg))");
    expect(step("ring-turn", "to")?.decls.get("transform")).toBe("none");
    // the countdown tick moves only: no opacity dip, and it ends at no transform
    const tick = step("tick", "from");
    expect(tick?.decls.has("opacity"), "tick has no opacity").toBe(false);
    expect(tick?.decls.get("transform")).toMatch(/translateY/);
    expect(step("tick", "to")?.decls.get("transform")).toBe("none");
    expect([...(step("tick", "to")?.decls.keys() ?? [])]).toEqual(["transform"]);
  });

  it("the keyframe-end check covers every selector the animation runs on, including a circle with a rotation or flip", () => {
    const sheet = (circle: string) => `
      .doodle { transform: rotate(var(--rot, 0deg)) scaleX(var(--flip, 1)); }
      ${circle}
      ${MOTION_QUERY} {
        @keyframes doodle-pop { from { opacity: 0; transform: rotate(calc(var(--rot, 0deg) - 8deg)) scale(0.6); } to { opacity: 1; transform: rotate(var(--rot, 0deg)) scaleX(var(--flip, 1)); } }
        .doodle-circle, .big-score-spark { animation: doodle-pop 0.35s ease-out 0.15s both; }
      }`;
    const turned = { "--rot": "12deg", "--flip": "-1" };
    // a circle that cancels the transform loses its tilt and mirroring when the animation ends; only a rotation shows it
    expect(keyframeEndMismatches(sheet(".doodle-circle { transform: none; }"), "doodle-pop", "to", [".doodle"], {})).toEqual([]);
    expect(keyframeEndMismatches(sheet(".doodle-circle { transform: none; }"), "doodle-pop", "to", [".doodle"], turned)).toEqual([".doodle-circle"]);
    expect(keyframeEndMismatches(sheet(".doodle-circle { transform: translateX(2px); }"), "doodle-pop", "to", [".doodle"], {})).toEqual([".doodle-circle"]);
    // no override: both selectors inherit the .doodle transform and agree with the end of the keyframes
    expect(keyframeEndMismatches(sheet(""), "doodle-pop", "to", [".doodle"], turned)).toEqual([]);
    expect(keyframeEndMismatches(sheet(".doodle-underline { transform: none; }"), "doodle-pop", "to", [".doodle"], turned)).toEqual([]);
    // a keyframe name nothing uses, or a missing step, is reported instead of passing silently
    expect(keyframeEndMismatches(sheet(""), "nope", "to", [".doodle"])).toHaveLength(1);
    expect(keyframeEndMismatches(sheet(""), "doodle-pop", "50%", [".doodle"])).toHaveLength(1);
  });

  it("the ring turns once while the stamp lands and then rests; the countdown tick lasts at most 300 ms", () => {
    const anim = effective(".sticker-ring").get("animation") ?? "";
    expect(anim).toMatch(/^ring-turn /);
    expect(anim).not.toMatch(/infinite/);
    expect(anim).toMatch(/\bboth\b/); // it stays at its final state
    const tick = effective(".countdown .tick").get("animation") ?? "";
    expect(toMs(splitTop(tick, " ").find((t) => toMs(t) !== undefined) ?? "")).toBeLessThanOrEqual(300);
  });

  it("the site title star stays inside the page padding on a phone (it is not clipped by the viewport)", () => {
    const px = (v: string | undefined) => Number(/^(-?\d+(?:\.\d+)?)px$/.exec(v ?? "")?.[1]);
    const star = effective(".site-title .doodle-star");
    const top = px(star.get("top"));
    const phonePad = px(parseTree(css).find((n) => n.prelude === ".page" && n.ancestors.includes("@media (max-width: 420px)"))?.decls.get("padding"));
    expect(phonePad, "phone page padding").toBeGreaterThan(0);
    // 4px of slack for the hover wiggle (scale 1.15, rotation) on a 20px star
    expect(-top + 4, "star top overhang").toBeLessThanOrEqual(phonePad);
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
      const name = r.selectors.join(", ");
      // A stroke-opacity lightens the line: the color that reaches the eye is the stroke over the card.
      const alpha = r.decls.has("stroke-opacity") ? Number(r.decls.get("stroke-opacity")) : 1;
      expect(alpha > 0 && alpha <= 1, `${name} stroke-opacity ${alpha}`).toBe(true);
      const shown = blend(hex as string, card, alpha);
      if (DECORATIVE_STROKES.has(name)) {
        // Decorative gridlines carry no information (the axis labels and the zero line do), so the 3:1 rule does not
        // apply, but they must stay visible at all.
        check(`${name} (decorative) stroke at opacity ${alpha}`, shown, card, 1.5);
      } else {
        check(`${name} stroke at opacity ${alpha}`, shown, card, 3);
      }
      seen.add(name);
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

  it("the hand face is used only by .note-hand and the in-chart note, anywhere in the stylesheet", () => {
    // Whole-stylesheet guard: any rule at all (inside @media too) that uses --f-hand must have exactly one allowed selector.
    expect(handFontOffenders(css)).toEqual([]);
    const users = parseTree(css).filter((n) => n.kind === "rule" && [...n.decls.values()].some((v) => v.includes("--f-hand")));
    expect(users.map((n) => n.prelude).sort()).toEqual([".chart .chart-note", ".note-hand"]);
    // The guard itself.
    for (const sheet of [
      ".hint { font-family: var(--f-hand) }",
      ".note-hand, .hint { font-family: var(--f-hand) }",
      ".chart .chart-note.big { font: 20px var(--f-hand) }",
      "@media (max-width: 1px) { .notice { font-family: var(--f-hand), cursive } }",
      ":root { --alias: var(--f-hand) }",
      ".hint { font-family: var(--font-hand) }",
      ".hint { font-family: Caveat, cursive }",
      '.notice { font: 1rem "Caveat" }',
      "@media (max-width: 1px) { .muted { font-family: var(--font-hand), cursive } }",
      ":root { --alias: var(--font-hand) }",
      ":root { --f-body: Caveat }",
      ".note-hand { font-family: var(--f-hand) } :root { --f-hand: var(--font-hand), Caveat, cursive; --other: var(--font-hand) }",
    ]) {
      expect(handFontOffenders(sheet), sheet).toHaveLength(1);
    }
    expect(handFontOffenders(".note-hand { font-family: var(--f-hand) } .chart-note { font-family: var(--f-hand) } :root { --f-hand: var(--font-hand), cursive }")).toEqual([]);
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

  it("no TS or TSX source writes a color literal: colors come from the stylesheet tokens", () => {
    // Every non-test .ts and .tsx file under src/ is scanned. The one exception is the share card's theme file, which
    // holds the literal copies of the tokens on purpose (satori cannot read CSS variables); the next test pins them.
    const offenders: string[] = [];
    const scanned: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.replace(/\\/g, "/").endsWith("/api/card/theme.ts")) {
          scanned.push(name);
          readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
            if (hasColorLiteral(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(scanned, "the scan reaches .ts and .tsx files").toEqual(expect.arrayContaining(["route.ts", "DrawChart.tsx", "market.ts"]));
    expect(offenders).toEqual([]);
  });

  it("the share card colors equal the stylesheet tokens they copy", () => {
    for (const [name, hex] of Object.entries(CARD_TOKENS)) expect(hex, name).toBe(token(name));
    // The card's graph-paper line is the page's: ink at --grid-pct (a transparent color, so not a token of its own).
    const pct = Number(/^(\d+(?:\.\d+)?)%$/.exec(tokens.get("--grid-pct") ?? "")?.[1]) / 100;
    const [r, g, b] = rgb(token("--ink"));
    expect(CARD_GRID_LINE).toBe(`rgba(${r},${g},${b},${pct})`);
    // The card is light paper: its text pairs hold the same ratios as on the site.
    check("card ink on card", CARD_TOKENS["--ink"], CARD_TOKENS["--card"], 7);
    check("card muted on card", CARD_TOKENS["--muted"], CARD_TOKENS["--card"], 4.5);
    check("card ink on footer highlight", CARD_TOKENS["--ink"], CARD_TOKENS["--hilite"], 7);
    for (const name of ["--green", "--blue", "--ochre-ink"] as const) check(`card ${name} text on card`, CARD_TOKENS[name], CARD_TOKENS["--card"], 4.5);
  });

  it("the harness itself: a faint color is rejected, a color literal is caught", () => {
    const bad = [
      'const c = "#3b82f6";',
      "fill: '#fff'",
      'stroke="#a78bfa80"',
      "color: rgb(1, 2, 3)",
      'border: "1px solid #a78bfa"',
      "const b = `2px dashed #fff`;",
      'boxShadow: "3px 3px 0 #161513"',
      'const c = "#ABC"',
      "background: hsl(210 40% 50%)",
      'style={{ background: "linear-gradient(rgba(22,21,19,0.06) 1px, transparent 1px)" }}',
      'fill="red"',
      'const c = "white";',
      "color: 'Tomato'",
      'border: "1px solid black"',
      'style={{ boxShadow: "2px 2px 0 navy" }}',
      'const x = { color: "darkslategray" }',
      // digit-only hex is a color wherever it is not prose: after a quote, `:`, `=` or `,`, a border style or a color property
      'fill="#000"',
      'style={{ color: "#333" }}',
      "color: '#999'",
      "'#999'",
      '"1px solid #000"',
      'stroke={"#999"}',
      'const ink = "#111";',
      "const shadow = `0 0 0 #1234`;",
      'style={{ boxShadow: "2px 2px 0 #555" }}',
      "color: #333",
      "border: 2px dashed #000",
      "const pair = [1,#123];",
    ];
    for (const line of bad) expect(hasColorLiteral(line), line).toBe(true);
    const ok = [
      'fill="url(#hatch-up-r1)"',
      "Round #123",
      "Order #1234 was filled",
      "see #main-content",
      'href="#add-form"',
      'style={{ stroke: "var(--c-human)" }}',
      'style={{ border: "1px solid var(--ink)" }}',
      "<p>Up candles are green and down candles are red.</p>",
      'const label = "Up is green";',
      'fill="transparent"',
      'color: "currentColor"',
      "// the blue series",
      "Round #123 of 9",
      "<p>Order #1234: filled</p>",
      "<p>Round #{round}</p>",
      'const t = "see ticket #123";',
    ];
    for (const line of ok) expect(hasColorLiteral(line), line).toBe(false);
    // stroke-opacity is accounted for: the muted token is 3:1+ on the card at full strength, but not at 45%, which is
    // why the trend gridlines are an explicit decorative exception instead of passing silently.
    expect(ratio(token("--muted"), card)).toBeGreaterThan(3);
    const faint = ratio(blend(token("--muted"), card, 0.45), card);
    expect(faint).toBeLessThan(3);
    expect(faint).toBeGreaterThanOrEqual(1.5);
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(DECORATIVE_STROKES.has(".trend .trend-grid")).toBe(true);
    expect(ratio("#c9c3b4", "#f6f1e4")).toBeLessThan(4.5);
    expect(ratio("#161513", "#ffffff")).toBeGreaterThan(15);
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
