// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TxState } from "@/lib/marketTx";
import type { JoinState } from "@/lib/player";
import { JoinPanelView } from "./PlayerPanel";

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

function mount(join: JoinState, over: { correctChain?: boolean; tx?: TxState } = {}) {
  const onJoin = vi.fn();
  const onRecheck = vi.fn();
  act(() => {
    root.render(<JoinPanelView join={join} correctChain={over.correctChain ?? true} tx={over.tx ?? { step: "idle" }} onJoin={onJoin} onRecheck={onRecheck} />);
  });
  return { onJoin, onRecheck };
}
const joinButton = () => container.querySelector("[data-join]") as HTMLButtonElement | null;

describe("JoinPanelView", () => {
  it("an allowlisted unregistered wallet sees Join as human, and clicking it calls onJoin", () => {
    const { onJoin } = mount({ state: "can-join", grant: 1000n });
    expect(container.textContent).toMatch(/allowlist/i);
    expect(container.textContent).toMatch(/1000 testnet points/);
    act(() => joinButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
  it("join is disabled on the wrong network and while a transaction is in progress", () => {
    mount({ state: "can-join", grant: 1000n }, { correctChain: false });
    expect(joinButton()?.disabled).toBe(true);
    expect(container.textContent).toMatch(/Switch your wallet to Base Sepolia/);
    mount({ state: "can-join", grant: 1000n }, { tx: { step: "signing", label: "Join as human" } });
    expect(joinButton()?.disabled).toBe(true);
  });
  it("a registered human sees the points balance and no join button", () => {
    mount({ state: "registered", balance: 950n });
    expect(container.querySelector("[data-balance]")?.getAttribute("data-balance")).toBe("950");
    expect(container.textContent).toMatch(/Registered as human/);
    expect(joinButton()).toBeNull();
  });
  it("says plainly when the wallet is not allowlisted, with no join button", () => {
    mount({ state: "not-allowlisted" });
    expect(container.querySelector("[data-not-allowlisted]")?.textContent).toMatch(/not on the human allowlist/i);
    expect(joinButton()).toBeNull();
  });
  it("an agent wallet is not offered the human join", () => {
    mount({ state: "agent", balance: 900n });
    expect(container.textContent).toMatch(/registered as an agent/i);
    expect(joinButton()).toBeNull();
  });
  it("covers the unavailable states without a join button", () => {
    for (const [state, re] of [
      ["unconfigured", /not configured/i],
      ["no-wallet", /connect a wallet/i],
      ["loading", /reading/i],
      ["error", /could not read/i],
    ] as const) {
      mount({ state });
      expect(container.textContent, state).toMatch(re);
      expect(joinButton()).toBeNull();
    }
  });
  it("shows the transaction status", () => {
    mount({ state: "registered", balance: 1n }, { tx: { step: "failed", message: "This wallet is not on the human allowlist." } });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/allowlist/);
  });
});
