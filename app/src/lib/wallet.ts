// Wallet choices and connection error text (pure). Two kinds of wallet: Coinbase Smart Wallet (passkey, talks
// to keys.coinbase.com, which some networks block) and any browser wallet (EIP-1193 `injected`, plus every
// wallet that announces itself through EIP-6963). Errors are shown in plain language: the raw message of a
// wallet or RPC error can contain endpoints and keys, so it is never displayed.

export type ConnectorInfo = { id: string; name: string; type: string };

export type WalletChoice = { id: string; label: string; kind: "smart" | "browser" };

const SMART_ID = "coinbaseWalletSDK";
const GENERIC_ID = "injected";

/** Wallet names come from the page via EIP-6963: keep a short, safe character set. */
function cleanName(name: string): string {
  const c = name.replace(/[^A-Za-z0-9 ._+-]/g, "").trim().slice(0, 24);
  return c === "" ? "Browser wallet" : c;
}

/**
 * The wallets to offer. The Smart Wallet comes first (no extension needed). Each wallet found through
 * EIP-6963 is listed by name; the generic `injected` entry is shown only when none was found.
 */
export function walletChoices(connectors: readonly ConnectorInfo[]): WalletChoice[] {
  const seen = new Set<string>();
  const smart: WalletChoice[] = [];
  const found: WalletChoice[] = [];
  let generic: WalletChoice | undefined;
  for (const c of connectors) {
    if (typeof c.id !== "string" || c.id === "" || seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.id === SMART_ID) smart.push({ id: c.id, label: "Coinbase Smart Wallet (passkey)", kind: "smart" });
    else if (c.id === GENERIC_ID) generic = { id: c.id, label: "Browser wallet (MetaMask and others)", kind: "browser" };
    else found.push({ id: c.id, label: cleanName(c.name), kind: "browser" });
  }
  return [...smart, ...(found.length > 0 ? found : generic ? [generic] : [])];
}

type ErrLike = { name?: unknown; code?: unknown; cause?: unknown };

/** Collects `name` and `code` along the cause chain (bounded). */
function signals(e: unknown): { names: Set<string>; codes: Set<number> } {
  const names = new Set<string>();
  const codes = new Set<number>();
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== null && typeof cur === "object"; i++) {
    const x = cur as ErrLike;
    if (typeof x.name === "string") names.add(x.name);
    if (typeof x.code === "number") codes.add(x.code);
    cur = x.cause;
  }
  return { names, codes };
}

const REJECTED = "You closed or declined the wallet request. Nothing was connected.";
const SWITCH_FAILED =
  "Your wallet could not switch to Base Sepolia (chain id 84532). Add the network in your wallet, then try again.";

function isRejection(s: ReturnType<typeof signals>): boolean {
  return s.codes.has(4001) || s.names.has("UserRejectedRequestError");
}

function isSwitchFailure(s: ReturnType<typeof signals>): boolean {
  return s.codes.has(4902) || s.names.has("SwitchChainError") || s.names.has("ChainNotConfiguredError");
}

/** Plain text for a failed connect. `kind` is the wallet type the user chose. */
export function connectErrorText(e: unknown, kind: "smart" | "browser"): string {
  const s = signals(e);
  if (isRejection(s)) return REJECTED;
  if (s.names.has("ProviderNotFoundError")) {
    return "No browser wallet was found. Install a wallet extension such as MetaMask, or use Coinbase Smart Wallet.";
  }
  if (s.codes.has(-32002) || s.names.has("ResourceUnavailableRpcError")) {
    return "Your wallet already has a request open. Open your wallet, answer it, then try again.";
  }
  if (isSwitchFailure(s)) return SWITCH_FAILED;
  if (s.names.has("ConnectorAlreadyConnectedError")) return "This wallet is already connected.";
  if (kind === "smart") {
    return "Could not connect Coinbase Smart Wallet. Its service may be blocked on your network. Try a browser wallet such as MetaMask instead.";
  }
  return "Could not connect your wallet. Unlock it, reload the page and try again.";
}

/** Plain text for a failed network switch. */
export function switchErrorText(e: unknown): string {
  return isRejection(signals(e)) ? "You declined the network switch. Switch to Base Sepolia in your wallet to continue." : SWITCH_FAILED;
}
