import { describe, expect, it } from "vitest";
import { connectErrorText, switchErrorText, walletChoices, type ConnectorInfo } from "./wallet";

const smart: ConnectorInfo = { id: "coinbaseWalletSDK", name: "Coinbase Wallet", type: "coinbaseWallet" };
const generic: ConnectorInfo = { id: "injected", name: "Injected", type: "injected" };
const metamask: ConnectorInfo = { id: "io.metamask", name: "MetaMask", type: "injected" };
const rabby: ConnectorInfo = { id: "io.rabby", name: "Rabby Wallet", type: "injected" };

describe("walletChoices", () => {
  it("offers the Smart Wallet and a generic browser wallet when no wallet announced itself", () => {
    const c = walletChoices([smart, generic]);
    expect(c.map((x) => x.kind)).toEqual(["smart", "browser"]);
    expect(c[0]?.label).toMatch(/Coinbase Smart Wallet/);
    expect(c[1]?.label).toMatch(/browser wallet/i);
  });
  it("lists each discovered wallet by name and hides the generic entry", () => {
    const c = walletChoices([smart, generic, metamask, rabby]);
    expect(c.map((x) => x.label)).toEqual([expect.stringMatching(/Smart Wallet/), "MetaMask", "Rabby Wallet"]);
    expect(c.some((x) => x.id === "injected")).toBe(false);
  });
  it("deduplicates by id and drops anything without an id", () => {
    const c = walletChoices([smart, metamask, metamask, { id: "", name: "x", type: "injected" }]);
    expect(c.map((x) => x.id)).toEqual(["coinbaseWalletSDK", "io.metamask"]);
  });
  it("cleans a hostile wallet name (it comes from the page, via EIP-6963)", () => {
    const c = walletChoices([{ id: "evil", name: "<img src=x onerror=alert(1)>" + "A".repeat(100), type: "injected" }]);
    expect(c[0]?.label).not.toMatch(/[<>]/);
    expect((c[0]?.label ?? "").length).toBeLessThanOrEqual(30);
  });
});

describe("connectErrorText: plain language, no raw RPC text", () => {
  it("wallet rejection", () => {
    const e = Object.assign(new Error("User rejected the request. Details: {rpc: https://x.example}"), { name: "UserRejectedRequestError", code: 4001 });
    expect(connectErrorText(e, "browser")).toMatch(/closed|declined|rejected/i);
    expect(connectErrorText(e, "browser")).not.toMatch(/rpc|https|Details/i);
  });
  it("finds the cause in a wrapped error", () => {
    const inner = Object.assign(new Error("x"), { code: 4001 });
    const e = Object.assign(new Error("wrapper http://rpc.example"), { cause: inner });
    expect(connectErrorText(e, "browser")).toMatch(/closed|declined|rejected/i);
  });
  it("no browser wallet installed", () => {
    const e = Object.assign(new Error("Provider not found."), { name: "ProviderNotFoundError" });
    expect(connectErrorText(e, "browser")).toMatch(/install|no browser wallet/i);
  });
  it("request already open in the wallet (-32002)", () => {
    expect(connectErrorText(Object.assign(new Error("pending"), { code: -32002 }), "browser")).toMatch(/already|open/i);
  });
  it("chain switch or add failures name Base Sepolia", () => {
    const e = Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
    expect(connectErrorText(e, "browser")).toMatch(/Base Sepolia/);
    expect(connectErrorText(Object.assign(new Error("x"), { name: "SwitchChainError" }), "smart")).toMatch(/Base Sepolia/);
  });
  it("an unknown Smart Wallet failure points at the blocked-network case and the alternative", () => {
    const t = connectErrorText(new TypeError("Failed to fetch https://keys.coinbase.com/connect"), "smart");
    expect(t).toMatch(/browser wallet/i);
    expect(t).not.toMatch(/keys\.coinbase\.com|https|fetch/i);
  });
  it("an unknown browser wallet failure is generic and never echoes the message", () => {
    const t = connectErrorText(new Error("internal: nonce 0x12 at https://rpc.example/key123"), "browser");
    expect(t).not.toMatch(/nonce|rpc|key123|https/i);
    expect(t.length).toBeGreaterThan(10);
  });
  it("handles non-error values", () => {
    expect(connectErrorText(undefined, "browser").length).toBeGreaterThan(10);
    expect(connectErrorText("boom", "smart").length).toBeGreaterThan(10);
  });
});

describe("switchErrorText", () => {
  it("rejection versus failure, both mention Base Sepolia", () => {
    expect(switchErrorText(Object.assign(new Error("x"), { code: 4001 }))).toMatch(/declined|rejected|closed/i);
    expect(switchErrorText(new Error("RPC 500 at https://x"))).toMatch(/Base Sepolia/);
    expect(switchErrorText(new Error("RPC 500 at https://x"))).not.toMatch(/https|500/);
  });
});
