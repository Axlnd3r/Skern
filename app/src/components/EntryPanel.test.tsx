// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayState } from "@/lib/actionTx";
import type { TxState } from "@/lib/marketTx";
import type { EntryView } from "@/lib/player";
import { EntryPanel, EntryPanelView } from "./EntryPanel";

// The wiring test below replaces the browser hooks; the pure view and deriveEntry stay real.
const lookupMock = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/useActions", () => ({
  useSaltLookup: () => lookupMock.current,
  useEntryActions: () => {
    throw new Error("not used: EntryPanel receives its actions as a prop");
  },
}));

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

const committed = (over: Partial<EntryView> = {}): EntryView => ({
  stage: "committed",
  headline: "Committed on-chain, not revealed yet.",
  detail: "The reveal window is open.",
  canRelay: true,
  canReveal: true,
  ...over,
});

function mount(view: EntryView, over: { tx?: TxState; relay?: RelayState; relayAck?: boolean } = {}) {
  const f = { onRelay: vi.fn(), onReveal: vi.fn(), onRecheck: vi.fn() };
  act(() => {
    root.render(<EntryPanelView view={view} relayAck={over.relayAck ?? false} tx={over.tx ?? { step: "idle" }} relay={over.relay ?? { step: "idle" }} {...f} />);
  });
  return f;
}
const q = (sel: string) => container.querySelector(sel) as HTMLButtonElement | null;
const click = (el: Element | null) => act(() => (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("EntryPanelView", () => {
  it("shows nothing before there is a commit", () => {
    mount({ stage: "none", headline: "", detail: "", canRelay: false, canReveal: false });
    expect(container.textContent).toBe("");
  });

  it("a committed entry offers the relay and the manual reveal during the reveal window", () => {
    const f = mount(committed());
    expect(q("[data-entry-stage]")?.getAttribute("data-entry-stage")).toBe("committed");
    click(q("[data-relay-send]"));
    click(q("[data-reveal-manual]"));
    expect(f.onRelay).toHaveBeenCalledTimes(1);
    expect(f.onReveal).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/saved in this browser/i);
  });

  it("offers no manual reveal outside the reveal window", () => {
    mount(committed({ canReveal: false }));
    expect(q("[data-reveal-manual]")).toBeNull();
    expect(q("[data-relay-send]")).not.toBeNull();
  });

  it("offers neither action when none is allowed (window over, no saved path)", () => {
    mount(committed({ canRelay: false, canReveal: false }));
    expect(q("[data-relay-send]")).toBeNull();
    expect(q("[data-reveal-manual]")).toBeNull();
  });

  it("revealed on-chain is stated only from the entry stage, and no action remains", () => {
    mount({ stage: "revealed", headline: "Revealed on-chain. Your path counts toward the Human consensus.", detail: "", canRelay: false, canReveal: false });
    expect(container.textContent).toMatch(/Revealed on-chain/);
    expect(q("[data-relay-send]")).toBeNull();
  });

  it("a relay 'revealed' answer is worded as the relay's report, not as the chain's", () => {
    mount(committed(), { relay: { step: "done", outcome: { state: "revealed", code: "REVEALED" } } });
    expect(q("[data-relay]")?.textContent).toMatch(/relay reports/i);
    expect(container.textContent).not.toMatch(/^Revealed on-chain/);
  });

  it("queued and pending are in progress (not errors); retry and unavailable are errors", () => {
    mount(committed(), { relay: { step: "done", outcome: { state: "queued" } } });
    expect(q("[data-relay]")?.className).toBe("ok");
    expect(q("[data-relay]")?.textContent).toMatch(/will reveal it for you/i);
    mount(committed(), { relay: { step: "done", outcome: { state: "pending" } } });
    expect(q("[data-relay]")?.className).toBe("ok");
    mount(committed(), { relay: { step: "done", outcome: { state: "unavailable", message: "The reveal relay is not available. Reveal yourself." } } });
    expect(q("[data-relay]")?.className).toBe("error");
    expect(q("[data-relay]")?.textContent).toMatch(/not available/);
  });

  it("disables both buttons while a transaction or a relay request is in progress", () => {
    mount(committed(), { tx: { step: "signing", label: "Reveal your path" } });
    expect(q("[data-relay-send]")?.disabled).toBe(true);
    expect(q("[data-reveal-manual]")?.disabled).toBe(true);
    mount(committed(), { relay: { step: "sending" } });
    expect(q("[data-relay-send]")?.disabled).toBe(true);
  });

  it("remembers that the relay already has the path after a reload", () => {
    mount(committed(), { relayAck: true });
    expect(q('[data-relay="acknowledged"]')).not.toBeNull();
  });

  it("shows the transaction status even before an entry exists (a commit in progress)", () => {
    mount({ stage: "none", headline: "", detail: "", canRelay: false, canReveal: false }, { tx: { step: "signing", label: "Commit your path" } });
    expect(container.textContent).toMatch(/Confirm in your wallet: Commit your path/);
  });

  it("a pending transaction does not block the relay button once the commit is on chain", () => {
    const f = mount(committed(), { tx: { step: "pending", label: "Commit your path", hash: `0x${"ab".repeat(32)}` } });
    expect(q("[data-relay-send]")?.disabled).toBe(false);
    expect(q("[data-reveal-manual]")?.disabled).toBe(true);
    click(q("[data-relay-send]"));
    expect(f.onRelay).toHaveBeenCalledTimes(1);
  });

  it("an unconfirmed transaction offers a re-check, not a second send", () => {
    const f = mount(committed(), { tx: { step: "unconfirmed", label: "Reveal your path", hash: `0x${"ab".repeat(32)}`, message: "Sent, not confirmed." } });
    expect(q("[data-recheck]")).not.toBeNull();
    expect(q("[data-reveal-manual]")?.disabled).toBe(true);
    click(q("[data-recheck]"));
    expect(f.onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe("EntryPanel wiring (stale pending commit transaction after a reload)", () => {
  const CHAIN_HASH = `0x${"11".repeat(32)}` as const;
  const OTHER_HASH = `0x${"22".repeat(32)}` as const;
  const WHO = `0x${"33".repeat(20)}` as const;
  const pending: TxState = { step: "pending", label: "Commit your path", hash: `0x${"ab".repeat(32)}` };

  function wire(opts: { savedHash: `0x${string}`; tx: TxState }) {
    lookupMock.current = { state: "found", record: { hash: opts.savedHash, relayAck: false } };
    const resendRelay = vi.fn(async () => {});
    const actions = {
      tx: opts.tx,
      relay: { step: "idle" } as RelayState,
      commit: vi.fn(),
      resendRelay,
      reveal: vi.fn(),
      recheck: vi.fn(),
    };
    const player = {
      reads: { entry: { kind: 1, revealed: false, hash: CHAIN_HASH, path: [] } },
      refetch: vi.fn(),
      configured: true,
      address: WHO,
      connected: true,
      correctChain: true,
    };
    act(() => {
      root.render(<EntryPanel roundId={1n} phase="reveal" closing={false} player={player as never} actions={actions as never} />);
    });
    return actions;
  }

  it("sends the saved path to the relay although the commit transaction still shows pending, when the chain hash is a saved record", () => {
    const a = wire({ savedHash: CHAIN_HASH, tx: pending });
    expect(a.resendRelay).toHaveBeenCalledTimes(1);
    expect(q("[data-relay-send]")?.disabled).toBe(false);
  });

  it("does not relay when the chain hash matches no saved record", () => {
    const a = wire({ savedHash: OTHER_HASH, tx: pending });
    expect(a.resendRelay).not.toHaveBeenCalled();
    expect(q("[data-relay-send]")).toBeNull();
  });

  it("still waits while a transaction is being signed or checked", () => {
    const a = wire({ savedHash: CHAIN_HASH, tx: { step: "signing", label: "Commit your path" } });
    expect(a.resendRelay).not.toHaveBeenCalled();
    expect(q("[data-relay-send]")?.disabled).toBe(true);
  });
});
