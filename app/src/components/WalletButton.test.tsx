// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletView, type WalletViewProps } from "./WalletButton";

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

const CHOICES = [
  { id: "coinbaseWalletSDK", label: "Coinbase Smart Wallet (passkey)", kind: "smart" as const },
  { id: "io.metamask", label: "MetaMask", kind: "browser" as const },
];

function mount(over: Partial<WalletViewProps> = {}) {
  const fns = { onConnect: vi.fn(), onSwitch: vi.fn(), onDisconnect: vi.fn() };
  act(() => {
    root.render(
      <WalletView
        address={undefined}
        connected={false}
        correctChain={false}
        choices={CHOICES}
        pendingId={undefined}
        switching={false}
        errorText={undefined}
        {...fns}
        {...over}
      />,
    );
  });
  return fns;
}

const click = (el: Element | null) => act(() => (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("WalletView", () => {
  it("lets the user choose between the Smart Wallet and a browser wallet", () => {
    const f = mount();
    expect(container.querySelector("[data-wallet]")).toBeNull();
    click(container.querySelector("button"));
    const buttons = [...container.querySelectorAll("[data-wallet]")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Coinbase Smart Wallet (passkey)", "MetaMask"]);
    click(container.querySelector('[data-wallet="io.metamask"]'));
    expect(f.onConnect).toHaveBeenCalledWith("io.metamask");
  });

  it("disables the choices while connecting and shows which one is connecting", () => {
    mount({ pendingId: "io.metamask" });
    const mm = container.querySelector('[data-wallet="io.metamask"]') as HTMLButtonElement;
    expect(mm.disabled).toBe(true);
    expect(mm.textContent).toBe("Connecting...");
    expect((container.querySelector('[data-wallet="coinbaseWalletSDK"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a connection error as plain text next to the button", () => {
    mount({ errorText: "No browser wallet was found. Install a wallet extension such as MetaMask, or use Coinbase Smart Wallet." });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/No browser wallet/);
  });

  it("on the wrong network offers the switch (and disconnect) and says nothing is sent", () => {
    const f = mount({ connected: true, address: "0x48090D421F8B220431e46C6F05723C1C87710730", correctChain: false });
    const sw = [...container.querySelectorAll("button")].find((b) => /Switch to Base Sepolia/.test(b.textContent ?? ""));
    expect(sw).toBeDefined();
    click(sw as Element);
    expect(f.onSwitch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/Nothing is sent until/i);
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Disconnect") as Element);
    expect(f.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("shows a switch error in plain text", () => {
    mount({ connected: true, address: "0x48090D421F8B220431e46C6F05723C1C87710730", correctChain: false, errorText: "You declined the network switch." });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/declined/);
  });

  it("connected on Base Sepolia shows the short address", () => {
    mount({ connected: true, address: "0x48090D421F8B220431e46C6F05723C1C87710730", correctChain: true });
    expect(container.querySelector(".addr")?.textContent).toBe("0x4809...0730");
    expect(container.textContent).not.toMatch(/Switch to Base Sepolia/);
  });
});
