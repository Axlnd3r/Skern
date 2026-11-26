// In-flight transaction memory (Task 15 follow-up): after a transaction is sent, its hash is kept in
// localStorage per (chain, round, wallet, action slot). Actions that must not overlap share a slot (commit and
// reveal: "entry"; bet and market claim: "market"); the Arena claim has its own slot, so releasing one family
// never clears or shows another family's hash. A reload or a second tab then sees "a transaction is still
// pending" and does not send the same action again. It is a guard, not a source of truth: the chain decides,
// and a record expires after INFLIGHT_TTL_MS so a transaction that was dropped cannot block the wallet forever.
// Storage is untrusted: damaged or throwing storage means "no record" (the contract still rejects a repeat).

import type { Address, Hash } from "viem";

/** The part of the Web Storage API used here. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Web Storage enumeration (optional: a store without it can still be read and written by key). */
  readonly length?: number;
  key?(index: number): string | null;
}

export class MemoryKV implements KV {
  private readonly m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  get length(): number {
    return this.m.size;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
}

/** `localStorage`, or null when it is missing or blocked (private mode, disabled cookies). */
export function browserStorage(): KV | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    const probe = "consensus-path:probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** A sent transaction counts as pending for this long (Base Sepolia mines in seconds; this is generous). */
export const INFLIGHT_TTL_MS = 10 * 60 * 1000;

export type InflightRecord = { action: string; label: string; hash: Hash; at: number };

/** Which transactions may not overlap: one in-flight record per (round, wallet, slot). */
export type InflightSlot = "join" | "entry" | "arena-claim" | "market";

export function inflightKey(chainId: number, id: bigint | undefined, who: Address, slot: InflightSlot): string {
  return `consensus-path:tx:v2:${chainId}:${(id ?? 0n).toString()}:${who.toLowerCase()}:${slot}`;
}

export interface InflightStore {
  get(id: bigint | undefined, who: Address, slot: InflightSlot): InflightRecord | null;
  /** False when nothing could be stored (the caller still goes on; the in-memory state guards this tab). */
  set(id: bigint | undefined, who: Address, slot: InflightSlot, rec: Omit<InflightRecord, "at">): boolean;
  clear(id: bigint | undefined, who: Address, slot: InflightSlot): void;
}

function parseRecord(text: string): InflightRecord | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object") return null;
  const { action, label, hash, at } = j as Record<string, unknown>;
  if (typeof action !== "string" || typeof label !== "string") return null;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { action: action.slice(0, 40), label: label.slice(0, 120), hash: hash as Hash, at };
}

/** The in-flight store on `localStorage`, created on first use so that importing it on the server is harmless. */
export function browserInflight(chainId: number): InflightStore {
  let real: InflightStore | undefined;
  const store = (): InflightStore => (real ??= createInflightStore(browserStorage(), chainId));
  return {
    get: (id, who, slot) => store().get(id, who, slot),
    set: (id, who, slot, rec) => store().set(id, who, slot, rec),
    clear: (id, who, slot) => store().clear(id, who, slot),
  };
}

export function createInflightStore(kv: KV | null, chainId: number, now: () => number = Date.now): InflightStore {
  return {
    get(id, who, slot) {
      if (kv === null) return null;
      const key = inflightKey(chainId, id, who, slot);
      try {
        const text = kv.getItem(key);
        if (text === null) return null;
        const rec = parseRecord(text);
        if (rec === null) return null;
        if (now() - rec.at > INFLIGHT_TTL_MS) {
          kv.removeItem(key);
          return null;
        }
        return rec;
      } catch {
        return null;
      }
    },
    set(id, who, slot, rec) {
      if (kv === null) return false;
      try {
        kv.setItem(inflightKey(chainId, id, who, slot), JSON.stringify({ ...rec, at: now() }));
        return true;
      } catch {
        return false;
      }
    },
    clear(id, who, slot) {
      if (kv === null) return;
      try {
        kv.removeItem(inflightKey(chainId, id, who, slot));
      } catch {
        /* nothing to do */
      }
    },
  };
}
