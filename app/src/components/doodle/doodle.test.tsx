// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Countdown } from "../Countdown";
import { DashboardView } from "../DashboardView";
import { PhaseTracker } from "../PhaseTracker";
import { simulatedRounds } from "@/lib/history";
import { Annotation } from "./Annotation";
import { ANNOTATION_MAX, fillRing, markStyle, shortNote, stickerFontSize } from "./helpers";
import { Arrow, Cloud, Pencil, ScribbleCircle, Sparkle, Squiggle, Star, Sticker, Tick, Underline } from "./index";
import { PhaseSticker, ringFor } from "./PhaseSticker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("doodle marks", () => {
  const marks: [string, React.ReactNode][] = [
    ["Underline", <Underline key="u" />],
    ["Squiggle", <Squiggle key="s" />],
    ["Star", <Star key="st" />],
    ["Sparkle", <Sparkle key="sp" />],
    ["Arrow", <Arrow key="a" />],
    ["Arrow leader", <Arrow key="al" variant="leader" />],
    ["Cloud", <Cloud key="c" />],
    ["ScribbleCircle", <ScribbleCircle key="sc" />],
    ["Pencil", <Pencil key="p" />],
    ["Tick", <Tick key="t" />],
    ["Sticker", <Sticker key="sk" label="MARKET" ring="ROUND 1 · " />],
  ];

  it.each(marks)("%s is decorative: aria-hidden, not focusable, a .doodle (pointer-events none in CSS)", (_name, node) => {
    render(node);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.classList.contains("doodle")).toBe(true);
    // Hand-drawn paths only: no perfect geometry primitives.
    expect(container.querySelector("circle, rect, ellipse, line, polygon")).toBeNull();
    // No tab stop and no link inside.
    expect(container.querySelector("a, button, [tabindex]")).toBeNull();
  });

  it("class, size, rotation and flip reach the svg", () => {
    render(<Star className="x" size={30} rotate={12} flip />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.classList.contains("x")).toBe(true);
    expect(svg.style.width).toBe("30px");
    expect(svg.style.getPropertyValue("--rot")).toBe("12deg");
    expect(svg.style.getPropertyValue("--flip")).toBe("-1");
  });
});

describe("Sticker", () => {
  it("writes its ring text on a circle path, hidden from assistive technology", () => {
    render(<Sticker label="SETTLED" ring="ROUND 7 · TESTNET POINTS ONLY · " />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const textPath = container.querySelector("textPath") as SVGElement;
    expect(textPath.textContent).toBe("ROUND 7 · TESTNET POINTS ONLY · ");
    const href = textPath.getAttribute("href") as string;
    expect(href.startsWith("#")).toBe(true);
    const guide = container.querySelector(href) as SVGPathElement;
    expect(guide).not.toBeNull();
    expect(guide.tagName.toLowerCase()).toBe("path");
    expect(guide.closest("defs")).not.toBeNull();
    expect(container.querySelector(".sticker-label")?.textContent).toBe("SETTLED");
  });

  it("gives every sticker its own guide id", () => {
    render(
      <>
        <Sticker label="A" ring="x " />
        <Sticker label="B" ring="y " />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("defs path")).map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("PhaseSticker", () => {
  it("names the round and the testnet note on the ring and the phase in the middle", () => {
    render(<PhaseSticker phase="market" roundId={12n} />);
    expect(container.querySelector(".sticker-label")?.textContent).toBe("MARKET");
    expect(container.querySelector("textPath")?.textContent).toContain("ROUND 12");
    expect(container.querySelector("textPath")?.textContent).toContain("TESTNET POINTS ONLY");
    expect(container.querySelector(".sticker-wrap")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("mounts a new stamp when the phase changes (so the stamp animation plays) and keeps it otherwise", () => {
    render(<PhaseSticker phase="commit" roundId={1n} />);
    const first = container.querySelector("svg.doodle-sticker");
    render(<PhaseSticker phase="commit" roundId={1n} />);
    expect(container.querySelector("svg.doodle-sticker")).toBe(first);
    render(<PhaseSticker phase="reveal" roundId={1n} />);
    const second = container.querySelector("svg.doodle-sticker");
    expect(second).not.toBe(first);
    expect(container.querySelector(".sticker-label")?.textContent).toBe("REVEAL");
  });

  it("fits every phase word in the inner ring", () => {
    for (const w of ["COMMIT", "REVEAL", "MARKET", "PLAY", "SETTLED", "VOID"]) expect(stickerFontSize(w) * w.length * 0.5).toBeLessThanOrEqual(70);
    expect(ringFor(3n).length).toBeGreaterThanOrEqual(44);
  });
});

describe("Countdown", () => {
  it("keeps the aria-label and the visible text, and remounts the tick node only when the value changes", () => {
    render(<Countdown text="00:10" />);
    const p = container.querySelector("p.countdown") as HTMLElement;
    expect(p.getAttribute("aria-label")).toBe("Time left in this phase");
    expect(p.textContent).toBe("00:10");
    const a = container.querySelector(".tick");
    render(<Countdown text="00:10" />);
    expect(container.querySelector(".tick")).toBe(a);
    render(<Countdown text="00:09" />);
    const b = container.querySelector(".tick");
    expect(b).not.toBe(a);
    expect(container.querySelector("p.countdown")?.textContent).toBe("00:09");
  });
});

describe("PhaseTracker ticks", () => {
  it("draws a pencil tick on done steps only, and keeps the step text", () => {
    render(<PhaseTracker phase="market" />);
    const done = Array.from(container.querySelectorAll("li.done"));
    expect(done.map((li) => li.textContent)).toEqual(["Commit", "Reveal"]);
    for (const li of done) expect(li.querySelector("svg.tracker-tick")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("svg.tracker-tick")).toHaveLength(2);
    expect(container.querySelector("li[aria-current='step']")?.textContent).toBe("Market");
  });

  it("a void round ticks the steps before the void step", () => {
    render(<PhaseTracker phase="void" />);
    expect(container.querySelectorAll("svg.tracker-tick")).toHaveLength(4);
  });
});

describe("annotations", () => {
  it("are decorative and short", () => {
    render(<Annotation text="your draw" />);
    const row = container.querySelector(".note-row") as HTMLElement;
    expect(row.getAttribute("aria-hidden")).toBe("true");
    expect(row.querySelector(".note-hand")?.textContent).toBe("your draw");
    expect(shortNote("a".repeat(ANNOTATION_MAX + 10)).length).toBeLessThanOrEqual(ANNOTATION_MAX);
    expect(shortNote("pick a side")).toBe("pick a side");
  });

  it("the hand face class is used by Annotation only, never by body text or disclosures", () => {
    const root = join(__dirname, "..", "..");
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && readFileSync(full, "utf8").includes("note-hand")) users.push(name);
      }
    };
    walk(root);
    expect(users).toEqual(["Annotation.tsx"]);
  });
});

describe("helpers", () => {
  it("fillRing repeats the base until the ring is full", () => {
    expect(fillRing("AB ", 7)).toBe("AB AB AB ");
    expect(fillRing("AB", 4)).toBe("AB AB ");
    expect(fillRing("LONG TEXT HERE ", 4)).toBe("LONG TEXT HERE ");
  });

  it("markStyle carries size and orientation", () => {
    const s = markStyle(40, 0.5, -10, true) as Record<string, unknown>;
    expect(s).toMatchObject({ width: 40, height: 20, "--rot": "-10deg", "--flip": -1 });
  });
});

describe("dashboard tables", () => {
  it("sit in a keyboard-reachable horizontal scroll wrapper", () => {
    const html = renderToStaticMarkup(<DashboardView rounds={simulatedRounds()} houseAgents={new Set()} houseError={null} />);
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const wrappers = Array.from(doc.querySelectorAll("div.table-scroll"));
    expect(wrappers.length).toBeGreaterThanOrEqual(1);
    for (const w of wrappers) {
      expect(w.getAttribute("tabindex")).toBe("0");
      expect(w.getAttribute("role")).toBe("region");
      expect(w.getAttribute("aria-label")).toMatch(/table/i);
      expect(w.querySelector(":scope > table.dash-table")).not.toBeNull();
    }
    // Every dashboard table is inside a wrapper.
    expect(doc.querySelectorAll("table.dash-table")).toHaveLength(wrappers.length);
  });
});
