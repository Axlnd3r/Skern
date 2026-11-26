// @vitest-environment jsdom
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
