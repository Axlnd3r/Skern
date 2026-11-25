// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { score, type Path } from "../../../shared/score";
import { STEP_MS } from "@/lib/reveal";
import { RevealPlayer } from "./RevealPlayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = 100;
const REAL: Path = [
  { close: 40, high: 70, low: -5 },
  { close: 10, high: 50, low: 0 },
  { close: 60, high: 85, low: 5 },
];
const HUMAN: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];
const AGENT: Path = [
  { close: 30, high: 60, low: 0 },
  { close: 0, high: 40, low: -10 },
  { close: 50, high: 70, low: -20 },
];

let container: HTMLDivElement;
let root: Root;

function mount(props: { autoPlay?: boolean; initialStep?: number } = {}) {
  act(() => {
    root.render(<RevealPlayer real={REAL} human={HUMAN} agent={AGENT} T={T} {...props} />);
  });
}

const realCandles = () => Array.from(container.querySelectorAll('g[data-series="real"]')).map((g) => g.getAttribute("data-candle"));
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement;
const click = (label: string) =>
  act(() => {
    button(label).click();
  });

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("RevealPlayer stepping (real state and timers)", () => {
  it("autoplay reveals exactly one more candle per step, never all at once", () => {
    mount();
    expect(realCandles()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(STEP_MS - 1);
    });
    expect(realCandles()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(realCandles()).toEqual(["1"]);
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(realCandles()).toEqual(["1", "2"]);
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(realCandles()).toEqual(["1", "2", "3"]);
    act(() => {
      vi.advanceTimersByTime(10 * STEP_MS);
    });
    expect(realCandles()).toEqual(["1", "2", "3"]);
  });

  it("the live score appears with the first candle and equals the shared score at the end", () => {
    mount();
    expect(container.querySelector("[data-score-human]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(container.querySelector("[data-score-human]")).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
    }
    expect(container.querySelector("[data-score-human]")?.getAttribute("data-score-human")).toBe(String(score(HUMAN, REAL, T)));
    expect(container.querySelector("[data-score-agent]")?.getAttribute("data-score-agent")).toBe(String(score(AGENT, REAL, T)));
  });

  it("Next candle advances one candle per click and stops at three", () => {
    mount({ autoPlay: false });
    click("Next candle");
    expect(realCandles()).toEqual(["1"]);
    click("Next candle");
    expect(realCandles()).toEqual(["1", "2"]);
    click("Next candle");
    expect(realCandles()).toEqual(["1", "2", "3"]);
    expect(button("Next candle").disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(10 * STEP_MS);
    });
    expect(realCandles()).toEqual(["1", "2", "3"]);
  });

  it("without autoplay nothing advances on its own", () => {
    mount({ autoPlay: false });
    act(() => {
      vi.advanceTimersByTime(10 * STEP_MS);
    });
    expect(realCandles()).toEqual([]);
  });

  it("Skip to the end shows all three candles; Replay starts again from none and steps one at a time", () => {
    mount({ autoPlay: false });
    click("Skip to the end");
    expect(realCandles()).toEqual(["1", "2", "3"]);
    click("Replay");
    expect(realCandles()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(realCandles()).toEqual(["1"]);
  });

  it("states that the early score is an estimate", () => {
    mount({ autoPlay: false, initialStep: 1 });
    const note = container.querySelector("[data-partial-note]")?.textContent ?? "";
    expect(note).toMatch(/estimate/i);
    expect(note).toMatch(/can still move/i);
    expect(note).not.toMatch(/matching the path/i);
  });
});
