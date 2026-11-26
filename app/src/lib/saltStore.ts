// The committed path and its salt, kept in localStorage so a human can still reveal after a reload or a
// failed relay. The salt is the only secret needed to reveal; losing it forfeits the stake. Rules:
//  - the record is written (and read back) BEFORE the commit transaction is sent;
//  - a generated salt is NEVER discarded or overwritten: every commit attempt of a (round, wallet) gets its
//    own record, stored under its own key (one key per commit hash, so two tabs cannot lose each other's
//    write). Which record is used is decided by the chain: the one whose hash equals the on-chain entry hash;
//  - a record written by the earlier single-record layout (the plain round+wallet key) still loads;
//  - a damaged record is reported as corrupt and left untouched, never replaced or deleted;
//  - it holds clear-text path and salt, which are secret only until the reveal window (the relay sees them too,
//    decision D1). It never holds a wallet key.

import type { Address, Hash, Hex } from "viem";
import { getAddress } from "viem";
import type { Path } from "../../../shared/score";
import { parsePath } from "./chainData";
import { commitHash } from "./commitHash";
import type { KV } from "./inflight";

export type SaltStatus = "pending" | "sent" | "committed";

export type SaltRecord = {
  version: 1;
  chainId: number;
  arena: Address;
  id: bigint;
  who: Address;
  path: Path;
  salt: Hex;
  hash: Hex;
  /** pending: written, commit not sent (or the transaction was reverted or replaced); sent: commit transaction sent; committed: commit confirmed. */
  status: SaltStatus;
  commitTx?: Hash;
  /** The relay accepted the path (queued, pending or revealed). */
  relayAck?: boolean;
  createdAt: number;
};

export type NewSalt = { id: bigint; who: Address; path: Path; salt: Hex; hash: Hex };

export type SaltLookup = { state: "none" } | { state: "found"; record: SaltRecord } | { state: "corrupt" };

export type SaveResult = { ok: true } | { ok: false; reason: "exists" | "storage" | "invalid" };

export type SaltPatch = { status?: SaltStatus; commitTx?: Hash | null; relayAck?: boolean };

/** Which record to patch: by its commit hash (known when it is saved) or by the commit transaction it was sent in. */
export type SaltSelector = { hash: Hex } | { commitTx: Hash };

export type SaltList = { records: SaltRecord[]; corrupt: number };

export interface SaltStore {
  /**
   * The record of (id, who). With `hash` (the on-chain entry hash) the record with that hash is returned when
   * there is one; otherwise, or when none matches, the most advanced record (committed > sent > pending, then
   * newest), so a caller can still report a mismatch. A damaged record gives "corrupt" only when no valid one exists.
   */
  load(id: bigint, who: Address, hash?: Hex): SaltLookup;
  /** Every valid record of (id, who), and how many damaged ones were found (they are left untouched). */
  list(id: bigint, who: Address): SaltList;
  /** Writes a new record under its own key. Never overwrites: the same hash, or a damaged record present, is "exists". */
  save(rec: NewSalt): SaveResult;
  patch(id: bigint, who: Address, sel: SaltSelector, patch: SaltPatch): boolean;
}

/** The key of the earlier single-record layout, and the prefix of every per-hash key. */
export function saltKey(chainId: number, arena: Address, id: bigint, who: Address): string {
  return `consensus-path:salt:v1:${chainId}:${arena.toLowerCase()}:${id.toString()}:${who.toLowerCase()}`;
}

/** The key of one record: the round+wallet key plus its commit hash. */
export function saltRecordKey(chainId: number, arena: Address, id: bigint, who: Address, hash: Hex): string {
  return `${saltKey(chainId, arena, id, who)}:${hash.toLowerCase()}`;
}

function serialize(r: SaltRecord): string {
  return JSON.stringify({ ...r, id: r.id.toString() });
}

function parseRecord(text: string, chainId: number, arena: Address, id: bigint, who: Address): SaltRecord | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.version !== 1 || o.chainId !== chainId) return null;
  if (typeof o.arena !== "string" || o.arena.toLowerCase() !== arena.toLowerCase()) return null;
  if (typeof o.id !== "string" || o.id !== id.toString()) return null;
  if (typeof o.who !== "string" || o.who.toLowerCase() !== who.toLowerCase()) return null;
  if (typeof o.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.salt)) return null;
  if (typeof o.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.hash)) return null;
  if (o.status !== "pending" && o.status !== "sent" && o.status !== "committed") return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  const path = parsePath(o.path);
  if (path === null) return null;
  try {
    if (commitHash(path, o.salt as Hex, who).toLowerCase() !== o.hash.toLowerCase()) return null;
  } catch {
    return null;
  }
  const commitTx = typeof o.commitTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(o.commitTx) ? (o.commitTx as Hash) : undefined;
  return {
    version: 1,
    chainId,
    arena: getAddress(arena),
    id,
    who: getAddress(who),
    path,
    salt: o.salt as Hex,
    hash: o.hash as Hex,
    status: o.status,
    ...(commitTx ? { commitTx } : {}),
    ...(o.relayAck === true ? { relayAck: true } : {}),
    createdAt: o.createdAt,
  };
}

type Slot = { key: string; rec: SaltRecord | null };

const rank = (r: SaltRecord): number => (r.status === "committed" ? 3 : r.status === "sent" ? 2 : 1);

export function createSaltStore(kv: KV | null, chainId: number, arena: Address, now: () => number = Date.now): SaltStore {
  /** All slots of (id, who): the legacy key and every per-hash key. `threw`: storage could not be read. */
  const slots = (id: bigint, who: Address): { slots: Slot[]; threw: boolean } => {
    if (kv === null) return { slots: [], threw: true };
    const base = saltKey(chainId, arena, id, who);
    const out: Slot[] = [];
    try {
      const keys = new Set<string>([base]);
      const n = kv.length;
      if (typeof n === "number" && typeof kv.key === "function") {
        for (let i = 0; i < n; i++) {
          const k = kv.key(i);
          if (k !== null && k.startsWith(`${base}:`)) keys.add(k);
        }
      }
      for (const key of keys) {
        const raw = kv.getItem(key);
        if (raw === null) continue;
        const rec = parseRecord(raw, chainId, arena, id, who);
        // a per-hash key must hold the record of exactly that hash
        const ok = rec !== null && (key === base || key === saltRecordKey(chainId, arena, id, who, rec.hash));
        out.push({ key, rec: ok ? rec : null });
      }
    } catch {
      return { slots: [], threw: true };
    }
    return { slots: out, threw: false };
  };

  const list = (id: bigint, who: Address): SaltList => {
    const s = slots(id, who).slots;
    return { records: s.flatMap((x) => (x.rec ? [x.rec] : [])), corrupt: s.filter((x) => x.rec === null).length };
  };

  const load = (id: bigint, who: Address, hash?: Hex): SaltLookup => {
    const l = list(id, who);
    const exact = hash === undefined ? undefined : l.records.find((r) => r.hash.toLowerCase() === hash.toLowerCase());
    const pick = exact ?? [...l.records].sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)[0];
    if (pick) return { state: "found", record: pick };
    return l.corrupt > 0 ? { state: "corrupt" } : { state: "none" };
  };

  const write = (key: string, rec: SaltRecord): boolean => {
    if (kv === null) return false;
    const text = serialize(rec);
    try {
      kv.setItem(key, text);
      return kv.getItem(key) === text; // read back: a lossy write must not count as saved
    } catch {
      return false;
    }
  };

  return {
    load,
    list,
    save(n) {
      try {
        if (commitHash(n.path, n.salt, n.who).toLowerCase() !== n.hash.toLowerCase() || parsePath(n.path) === null) {
          return { ok: false, reason: "invalid" };
        }
      } catch {
        return { ok: false, reason: "invalid" };
      }
      if (kv === null) return { ok: false, reason: "storage" };
      const existing = slots(n.id, n.who);
      if (existing.threw) return { ok: false, reason: "storage" };
      // Never overwrite: the same hash is there already, or a damaged record is (it might hold a committed salt).
      if (existing.slots.some((x) => x.rec === null || x.rec.hash.toLowerCase() === n.hash.toLowerCase())) {
        return { ok: false, reason: "exists" };
      }
      const rec: SaltRecord = {
        version: 1,
        chainId,
        arena: getAddress(arena),
        id: n.id,
        who: getAddress(n.who),
        path: n.path,
        salt: n.salt,
        hash: n.hash,
        status: "pending",
        createdAt: now(),
      };
      return write(saltRecordKey(chainId, arena, n.id, n.who, n.hash), rec) ? { ok: true } : { ok: false, reason: "storage" };
    },
    patch(id, who, sel, patch) {
      const hit = slots(id, who).slots.find(
        (x) =>
          x.rec !== null &&
          ("hash" in sel ? x.rec.hash.toLowerCase() === sel.hash.toLowerCase() : x.rec.commitTx?.toLowerCase() === sel.commitTx.toLowerCase()),
      );
      if (!hit || hit.rec === null) return false;
      const next: SaltRecord = { ...hit.rec };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.commitTx === null) delete next.commitTx;
      else if (patch.commitTx !== undefined) next.commitTx = patch.commitTx;
      if (patch.relayAck === true) next.relayAck = true;
      return write(hit.key, next);
    },
  };
}
