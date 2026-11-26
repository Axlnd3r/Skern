// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Path } from "../../../shared/score";
import type { MarketData } from "@/lib/market";
import type { TxState } from "@/lib/marketTx";
import { MarketPanelView, type MarketPanelViewProps } from "./MarketPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];

const data: MarketData = {
  status: 0,
  pools: { human: 100n, agent: 100n },
  stake: { human: 0n, agent: 0n },
  claimed: false,
  reveals: { human: 3n, agent: 3n },
  consensus: { human: { path: PATH, ready: true }, agent: { path: PATH, ready: true } },
  balance: 900n,
  cap: 200n,
  minReveals: 3n,
};

let container: HTMLDivElement;
let root: Root;

function mount(over: Partial<MarketPanelViewProps> = {}) {
  const onBet = vi.fn();
  const onClaim = vi.fn();
  const onRecheck = vi.fn();
  act(() => {
    root.render(
      <MarketPanelView
        roundId={7n}
        T={100}
        phase="market"
        closing={false}
        data={data}
        stale={false}
        connected
        correctChain
        tx={{ step: "idle" }}
        onBet={onBet}
        onClaim={onClaim}
        onRecheck={onRecheck}
        {...over}
      />,
    );
  });
  return { onBet, onClaim, onRecheck };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
const submit = () => container.querySelector<HTMLButtonElement>("button[data-bet-submit]") as HTMLButtonElement;
const amountInput = () => container.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MarketPanelView bet form", () => {
  it("labels the radios Human = 0 and Agent = 1 (the GapMarket Side enum)", () => {
    mount();
    const pairs = radios().map((r) => [r.parentElement?.textContent?.trim(), r.value]);
    expect(pairs).toEqual([
      ["Human", "0"],
      ["Agent", "1"],
    ]);
  });

  it("submits the chosen side and the typed amount", () => {
    const { onBet } = mount();
    type(amountInput(), "25");
    act(() => submit().click());
    expect(onBet).toHaveBeenCalledWith("human", "25");

    onBet.mockClear();
    act(() => radios()[1]?.click());
    act(() => submit().click());
    expect(onBet).toHaveBeenCalledWith("agent", "25");
  });

  it("does not submit an invalid or over-cap amount", () => {
    const { onBet } = mount();
    type(amountInput(), "201");
    expect(submit().disabled).toBe(true);
    act(() => submit().click());
    expect(onBet).not.toHaveBeenCalled();
    type(amountInput(), "200");
    expect(submit().disabled).toBe(false);
  });

  it("keeps betting disabled while a transaction is unconfirmed, and re-check is offered", () => {
    const tx: TxState = { step: "unconfirmed", label: "Bet 100 points on human", hash: `0x${"ab".repeat(32)}`, message: "Could not confirm." };
    const { onBet, onRecheck } = mount({ tx });
    expect(submit().disabled).toBe(true);
    expect(container.querySelector("[data-tx-unconfirmed]")?.textContent).toMatch(/not send it twice|twice/i);
    expect(container.querySelector("a")?.getAttribute("href")).toContain(`0x${"ab".repeat(32)}`);
    act(() => container.querySelector<HTMLButtonElement>("button[data-recheck]")?.click());
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onBet).not.toHaveBeenCalled();
  });

  it("while a resolved market's winner is unknown it says it is reading the result, not 'nothing to claim'", () => {
    mount({ phase: "settled", data: { ...data, status: 2, stake: { human: 10n, agent: 0n } } });
    const text = container.textContent ?? "";
    expect(text).toMatch(/reading the result/i);
    expect(text).not.toMatch(/nothing to claim/i);
    expect(container.querySelector<HTMLButtonElement>("button[data-claim-submit]")?.disabled).toBe(true);
  });

  it("once the winner is known a loser sees there is nothing to claim", () => {
    mount({
      phase: "settled",
      data: { ...data, status: 2, stake: { human: 10n, agent: 0n }, scores: { human: 40, agent: 60, humanPresent: true, agentPresent: true } },
    });
    expect(container.textContent).toMatch(/nothing to claim/i);
  });
});

describe("MarketPanelView 'pick a side' note", () => {
  const note = () => container.querySelector(".note-row");

  it("shows with the bet form (the same state) and sits just above it", () => {
    mount();
    expect(container.querySelector("form[data-bet-form]")).not.toBeNull();
    expect(note()?.textContent).toBe("pick a side");
    expect(note()?.getAttribute("aria-hidden")).toBe("true");
    expect(note()?.nextElementSibling?.matches("form[data-bet-form]")).toBe(true);
  });

  it("is absent whenever the bet form is not rendered", () => {
    // Market phase, but a side is below quorum: the market is cancelled, no form.
    mount({ data: { ...data, reveals: { human: 2n, agent: 3n } } });
    expect(container.querySelector("form[data-bet-form]")).toBeNull();
    expect(note()).toBeNull();
    // Market phase, quorum met but the consensus paths are not frozen yet: no form.
    mount({ data: { ...data, consensus: { human: { path: PATH, ready: false }, agent: { path: PATH, ready: false } } } });
    expect(container.querySelector("form[data-bet-form]")).toBeNull();
    expect(note()).toBeNull();
    // Other phases.
    for (const phase of ["commit", "reveal", "play", "settled", "void"] as const) {
      mount({ phase });
      expect(container.querySelector("form[data-bet-form]"), `${phase} form`).toBeNull();
      expect(note(), `${phase} note`).toBeNull();
    }
  });

  it("the page no longer renders the note on its own (it would show without a form)", () => {
    const page = readFileSync(join(__dirname, "..", "app", "market", "page.tsx"), "utf8");
    expect(page).not.toContain("pick a side");
    expect(page).not.toContain("Annotation");
  });
});
