import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { commitHash } from "./commitHash";
import { MemoryKV } from "./inflight";
import { createSaltStore, saltKey, type NewSalt } from "./saltStore";

const ARENA = "0x4Da1FBb0f99D27F566Aa08243A4D6B8276E69AB7" as const;
const WHO = "0x48090D421F8B220431e46C6F05723C1C87710730" as const;
const OTHER = "0x92881Ced4E598ee1b476A6066b41f7ac7213346e" as const;
const SALT = `0x${"11".repeat(32)}` as const;
const SALT2 = `0x${"22".repeat(32)}` as const;
const TX = `0x${"ab".repeat(32)}` as const;
const TX2 = `0x${"cd".repeat(32)}` as const;
const PATH: Path = [
  { close: 10, high: 20, low: -5 },
  { close: 5, high: 30, low: -10 },
  { close: 0, high: 12, low: -12 },
];

function rec(over: Partial<NewSalt> = {}): NewSalt {
  return { id: 7n, who: WHO, path: PATH, salt: SALT, hash: commitHash(PATH, SALT, WHO), ...over };
}
const rec2 = (): NewSalt => rec({ salt: SALT2, hash: commitHash(PATH, SALT2, WHO) });
const H1 = commitHash(PATH, SALT, WHO);
const H2 = commitHash(PATH, SALT2, WHO);

describe("salt store", () => {
  it("keys by chain, arena, round and lowercase wallet", () => {
    const k = saltKey(84532, ARENA, 7n, WHO);
    expect(k).toBe(saltKey(84532, ARENA.toLowerCase() as typeof ARENA, 7n, WHO.toLowerCase() as typeof WHO));
    expect(k).not.toBe(saltKey(84532, ARENA, 8n, WHO));
    expect(k).not.toBe(saltKey(84532, ARENA, 7n, OTHER));
  });

  it("saves, reads back {id, who, path, salt} and survives a new store on the same storage", () => {
    const kv = new MemoryKV();
    const s = createSaltStore(kv, 84532, ARENA, () => 5);
    expect(s.load(7n, WHO)).toEqual({ state: "none" });
    expect(s.save(rec())).toEqual({ ok: true });
    const again = createSaltStore(kv, 84532, ARENA, () => 9).load(7n, WHO);
    expect(again.state).toBe("found");
    if (again.state === "found") {
      expect(again.record).toMatchObject({ id: 7n, who: WHO, path: PATH, salt: SALT, status: "pending", createdAt: 5 });
    }
  });

  it("never discards a salt: a second save keeps the first, and each is found by its own hash", () => {
    const kv = new MemoryKV();
    const s = createSaltStore(kv, 84532, ARENA, () => 1);
    expect(s.save(rec())).toEqual({ ok: true });
    expect(s.save(rec2())).toEqual({ ok: true });
    // the same hash twice is refused (never rewritten)
    expect(s.save(rec())).toEqual({ ok: false, reason: "exists" });
    const a = s.load(7n, WHO, H1);
    const b = s.load(7n, WHO, H2);
    expect(a.state === "found" && a.record.salt).toBe(SALT);
    expect(b.state === "found" && b.record.salt).toBe(SALT2);
    expect(s.list(7n, WHO).records.map((r) => r.salt).sort()).toEqual([SALT, SALT2]);
    // another tab (new store, same storage) sees both
    const tab2 = createSaltStore(kv, 84532, ARENA, () => 2);
    expect(tab2.list(7n, WHO).records).toHaveLength(2);
    // other rounds and wallets do not see them
    expect(tab2.list(8n, WHO).records).toHaveLength(0);
    expect(tab2.list(7n, OTHER).records).toHaveLength(0);
  });

  it("load by a hash that no record has still returns the best record, so callers can report a mismatch", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    s.save(rec());
    const l = s.load(7n, WHO, `0x${"99".repeat(32)}`);
    expect(l.state === "found" && l.record.hash).toBe(H1);
  });

  it("without a hash it prefers a committed record over a sent one over a pending one", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    s.save(rec());
    s.save(rec2());
    expect(s.load(7n, WHO).state).toBe("found");
    s.patch(7n, WHO, { hash: H2 }, { status: "sent", commitTx: TX });
    const sent = s.load(7n, WHO);
    expect(sent.state === "found" && sent.record.hash).toBe(H2);
    s.patch(7n, WHO, { hash: H1 }, { status: "committed", commitTx: TX2 });
    const done = s.load(7n, WHO);
    expect(done.state === "found" && done.record.hash).toBe(H1);
  });

  it("still loads a record written by the earlier single-record layout, and patches it in place", () => {
    const kv = new MemoryKV();
    const legacyKey = saltKey(84532, ARENA, 7n, WHO);
    kv.setItem(
      legacyKey,
      JSON.stringify({ version: 1, chainId: 84532, arena: ARENA, id: "7", who: WHO, path: PATH, salt: SALT, hash: H1, status: "sent", commitTx: TX, createdAt: 3 }),
    );
    const s = createSaltStore(kv, 84532, ARENA, () => 9);
    const l = s.load(7n, WHO, H1);
    expect(l.state === "found" && l.record).toMatchObject({ salt: SALT, status: "sent", commitTx: TX });
    expect(s.list(7n, WHO).records).toHaveLength(1);
    // a new attempt does not touch it
    expect(s.save(rec2())).toEqual({ ok: true });
    expect(s.list(7n, WHO).records).toHaveLength(2);
    expect(s.patch(7n, WHO, { hash: H1 }, { status: "committed" })).toBe(true);
    expect(JSON.parse(kv.getItem(legacyKey) as string)).toMatchObject({ status: "committed", salt: SALT });
    // saving the legacy record's hash again is refused
    expect(s.save(rec())).toEqual({ ok: false, reason: "exists" });
  });

  it("reports a storage failure instead of pretending the salt is safe", () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(createSaltStore(failing, 84532, ARENA, () => 1).save(rec())).toEqual({ ok: false, reason: "storage" });
    expect(createSaltStore(null, 84532, ARENA, () => 1).save(rec())).toEqual({ ok: false, reason: "storage" });
    // A write that does not read back is also a failure.
    const lossy = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    expect(createSaltStore(lossy, 84532, ARENA, () => 1).save(rec())).toEqual({ ok: false, reason: "storage" });
  });

  it("refuses to save a record whose hash is not keccak(path, salt, who)", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    expect(s.save(rec({ hash: `0x${"00".repeat(32)}` }))).toEqual({ ok: false, reason: "invalid" });
  });

  it("flags a damaged record as corrupt and leaves it untouched", () => {
    const kv = new MemoryKV();
    const s = createSaltStore(kv, 84532, ARENA, () => 1);
    const key = saltKey(84532, ARENA, 7n, WHO);
    kv.setItem(key, "{broken");
    expect(s.load(7n, WHO)).toEqual({ state: "corrupt" });
    expect(s.list(7n, WHO)).toEqual({ records: [], corrupt: 1 });
    expect(s.save(rec())).toEqual({ ok: false, reason: "exists" });
    expect(kv.getItem(key)).toBe("{broken");
    // A well formed record with a wrong hash is also corrupt.
    kv.setItem(
      key,
      JSON.stringify({ version: 1, chainId: 84532, arena: ARENA, id: "7", who: WHO, path: PATH, salt: SALT, hash: `0x${"00".repeat(32)}`, status: "pending", createdAt: 1 }),
    );
    expect(s.load(7n, WHO)).toEqual({ state: "corrupt" });
  });

  it("a damaged record does not hide a good record that matches the on-chain hash", () => {
    const kv = new MemoryKV();
    const s = createSaltStore(kv, 84532, ARENA, () => 1);
    s.save(rec());
    kv.setItem(`${saltKey(84532, ARENA, 7n, WHO)}:${H2.toLowerCase()}`, "{broken");
    const l = s.load(7n, WHO, H1);
    expect(l.state === "found" && l.record.salt).toBe(SALT);
    expect(s.list(7n, WHO).corrupt).toBe(1);
  });

  it("patches status, commit tx and relay acknowledgement by hash, keeping path and salt", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    s.save(rec());
    s.save(rec2());
    expect(s.patch(7n, WHO, { hash: H1 }, { status: "sent", commitTx: TX })).toBe(true);
    expect(s.patch(7n, WHO, { hash: H1 }, { status: "committed", relayAck: true })).toBe(true);
    const l = s.load(7n, WHO, H1);
    expect(l.state === "found" && l.record).toMatchObject({ status: "committed", commitTx: TX, relayAck: true, salt: SALT, path: PATH });
    // the other record is untouched
    const o = s.load(7n, WHO, H2);
    expect(o.state === "found" && o.record).toMatchObject({ status: "pending", salt: SALT2 });
    expect(o.state === "found" && o.record.commitTx).toBeUndefined();
    expect(s.patch(8n, WHO, { hash: H1 }, { status: "sent" })).toBe(false);
    expect(s.patch(7n, WHO, { hash: `0x${"99".repeat(32)}` }, { status: "sent" })).toBe(false);
  });

  it("patches by the commit transaction hash (after a reload only the transaction is known)", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    s.save(rec());
    s.save(rec2());
    s.patch(7n, WHO, { hash: H2 }, { status: "sent", commitTx: TX });
    expect(s.patch(7n, WHO, { commitTx: TX }, { status: "committed" })).toBe(true);
    const l = s.load(7n, WHO, H2);
    expect(l.state === "found" && l.record.status).toBe("committed");
    const o = s.load(7n, WHO, H1);
    expect(o.state === "found" && o.record.status).toBe("pending");
    expect(s.patch(7n, WHO, { commitTx: TX2 }, { status: "committed" })).toBe(false);
  });

  it("can forget the commit transaction after it was mined and reverted or replaced (the record itself is kept)", () => {
    const s = createSaltStore(new MemoryKV(), 84532, ARENA, () => 1);
    s.save(rec());
    s.patch(7n, WHO, { hash: H1 }, { status: "sent", commitTx: TX });
    s.patch(7n, WHO, { commitTx: TX }, { status: "pending", commitTx: null });
    const l = s.load(7n, WHO, H1);
    expect(l.state === "found" && l.record.commitTx).toBeUndefined();
    expect(l.state === "found" && l.record.status).toBe("pending");
  });
});
