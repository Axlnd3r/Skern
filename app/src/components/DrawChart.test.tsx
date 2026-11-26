// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawChart, type DrawChartProps } from "./DrawChart";

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

const base: DrawChartProps = { T: 100, phase: "commit", closing: false, simulated: false, connected: true, onCommit: () => undefined };
function render(over: Partial<DrawChartProps> = {}) {
  act(() => root.render(<DrawChart {...base} {...over} />));
}
const commitButton = () => [...container.querySelectorAll("button")].find((b) => /Commit path|Working/.test(b.textContent ?? "")) as HTMLButtonElement;

describe("DrawChart commit button", () => {
  it("commits the drawn path when nothing blocks it", () => {
    const onCommit = vi.fn();
    render({ onCommit });
    expect(commitButton().disabled).toBe(false);
    act(() => commitButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("an outside reason (not registered, not enough points) disables it and is shown", () => {
    const onCommit = vi.fn();
    render({ onCommit, blocked: "Join as human first: this wallet is not registered." });
    expect(commitButton().disabled).toBe(true);
    expect(container.querySelector("[data-testid=commit-blocked]")?.textContent).toMatch(/join as human/i);
    act(() => commitButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("is disabled and says Working while a transaction is in progress", () => {
    render({ busy: true });
    expect(commitButton().disabled).toBe(true);
    expect(commitButton().textContent).toBe("Working...");
  });

  it("practice (simulated) rounds can never be committed", () => {
    const onCommit = vi.fn();
    render({ simulated: true, onCommit });
    expect(commitButton().disabled).toBe(true);
  });

  it("a drawing in progress survives the round changing from practice to live", () => {
    render({ simulated: true });
    const handle = container.querySelector('[data-handle="0"]') as SVGElement;
    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }));
    });
    const before = container.querySelector('[data-field="c1-close"]')?.textContent;
    expect(before).not.toBe("0");
    render({ simulated: false });
    expect(container.querySelector('[data-field="c1-close"]')?.textContent).toBe(before);
  });
});

describe("DrawChart drawing", () => {
  it("keeps one focusable slider per handle, 9 in all, with their names", () => {
    render();
    const sliders = [...container.querySelectorAll('[role="slider"]')];
    expect(sliders).toHaveLength(9);
    expect(sliders.map((e) => e.getAttribute("aria-label")).slice(0, 3)).toEqual(["Candle 1 high", "Candle 1 close", "Candle 1 low"]);
    for (const e of sliders) expect(e.getAttribute("tabindex")).toBe("0");
  });

  it("marks the three handle kinds with different shapes: circle, up triangle, down triangle", () => {
    render();
    const marks = [...container.querySelectorAll(".mark")].slice(0, 3);
    expect(marks.map((m) => m.tagName.toLowerCase())).toEqual(["polygon", "circle", "polygon"]); // drawn in the order high, close, low
    const apex = (m: Element) => {
      const pts = (m.getAttribute("points") ?? "").split(" ").map((p) => p.split(",").map(Number) as [number, number]);
      const cy = Number(container.querySelector('[data-handle="1"]')?.getAttribute("cy"));
      return (pts[0] as [number, number])[1] < cy; // first point is the tip
    };
    expect(apex(marks[0] as Element)).toBe(true); // high points up
    expect(apex(marks[2] as Element)).toBe(false); // low points down
    // the visible marks take no pointer events: the invisible handle circles stay the drag targets
    for (const m of container.querySelectorAll(".mark")) expect(m.getAttribute("data-handle")).toBeNull();
    expect(container.querySelectorAll(".mark").length).toBeGreaterThan(0);
  });

  it("the stylesheet gives the visible marks and the hand-written notes pointer-events: none", () => {
    // jsdom does not load globals.css, so read the rule itself: a mark that took events would steal drags from its handle.
    const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const declsOf = (selector: string) => {
      const out = new Map<string, string>();
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!(m[1] as string).split(",").some((s) => s.trim().replace(/\s+/g, " ") === selector)) continue;
        for (const d of (m[2] as string).split(";")) {
          const i = d.indexOf(":");
          if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
        }
      }
      return out;
    };
    render();
    // the classes the rules name are really on the rendered elements (and the notes sit in the chart svg)
    expect(container.querySelector("svg.chart .mark")).not.toBeNull();
    expect(container.querySelector("svg.chart .chart-note")).not.toBeNull();
    expect(declsOf(".chart .mark").get("pointer-events")).toBe("none");
    expect(declsOf(".chart .chart-note").get("pointer-events")).toBe("none");
    // the draggable handle is the only element that takes them
    expect(declsOf(".chart .handle").get("pointer-events")).not.toBe("none");
  });

  it("labels candle 1's handles with hidden hand-written notes, tracking the handle", () => {
    render();
    const labels = container.querySelector(".annotations") as SVGElement;
    expect(labels.getAttribute("aria-hidden")).toBe("true");
    expect([...labels.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["high", "close", "low"]);
    const before = labels.querySelector('[data-label="close"] text')?.getAttribute("y");
    act(() => {
      (container.querySelector('[data-handle="0"]') as SVGElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }),
      );
    });
    expect(labels.querySelector('[data-label="close"] text')?.getAttribute("y")).not.toBe(before);
  });

  it("fills the candle bodies from a hatch pattern defined in the same svg, opposite angles for up and down", () => {
    render();
    const patterns = [...container.querySelectorAll("defs pattern")];
    expect(patterns).toHaveLength(2);
    expect(patterns.map((p) => p.getAttribute("patternTransform"))).toEqual(["rotate(45)", "rotate(-45)"]);
    const ids = patterns.map((p) => p.getAttribute("id"));
    const fill = container.querySelector(".body")?.getAttribute("fill");
    expect(fill).toBe(`url(#${ids[0]})`); // the flat default candle counts as up
    // an up and a down candle never share a fill
    act(() => {
      (container.querySelector('[data-handle="0"]') as SVGElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector(".body")?.getAttribute("fill")).toBe(`url(#${ids[1]})`);
  });

  it("the axis text says P0 only; the long wording is in the note below", () => {
    render();
    const axis = [...container.querySelectorAll("text.axis")].map((t) => t.textContent);
    expect(axis).toContain("P0 (0 bp)");
    expect(axis.join(" ")).not.toMatch(/flat baseline/);
    expect(container.querySelector(".hint")?.textContent).toMatch(/flat baseline/);
  });
});
