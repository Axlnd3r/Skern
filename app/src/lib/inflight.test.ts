import { describe, expect, it } from "vitest";
import { INFLIGHT_TTL_MS, MemoryKV, createInflightStore, inflightKey } from "./inflight";

const A = "0x48090D421F8B220431e46C6F05723C1C87710730" as const;
const B = "0x92881Ced4E598ee1b476A6066b41f7ac7213346e" as const;
const H = `0x${"ab".repeat(32)}` as const;
const H2 = `0x${"cd".repeat(32)}` as const;

describe("inflight store (one pending transaction per round, wallet and action slot)", () => {
  it("keys by chain, round, lowercase wallet and slot", () => {
    expect(inflightKey(84532, 7n, A, "entry")).toBe(inflightKey(84532, 7n, A.toLowerCase() as typeof A, "entry"));
    expect(inflightKey(84532, 7n, A, "entry")).not.toBe(inflightKey(84532, 8n, A, "entry"));
    expect(inflightKey(84532, 7n, A, "entry")).not.toBe(inflightKey(84532, 7n, B, "entry"));
    expect(inflightKey(84532, 7n, A, "entry")).not.toBe(inflightKey(1, 7n, A, "entry"));
    expect(inflightKey(84532, undefined, A, "join")).toBe(inflightKey(84532, 0n, A, "join"));
    // the Arena claim and the market claim of the same round and wallet never share a slot
    expect(inflightKey(84532, 7n, A, "arena-claim")).not.toBe(inflightKey(84532, 7n, A, "market"));
    expect(inflightKey(84532, 7n, A, "entry")).not.toBe(inflightKey(84532, 7n, A, "arena-claim"));
  });

  it("round-trips a record and is visible to a second store on the same storage (second tab / reload)", () => {
    const kv = new MemoryKV();
    const tab1 = createInflightStore(kv, 84532, () => 1000);
    const tab2 = createInflightStore(kv, 84532, () => 2000);
    expect(tab2.get(7n, A, "entry")).toBeNull();
    expect(tab1.set(7n, A, "entry", { action: "commit", label: "Commit", hash: H })).toBe(true);
    expect(tab2.get(7n, A, "entry")).toEqual({ action: "commit", label: "Commit", hash: H, at: 1000 });
    expect(tab2.get(7n, B, "entry")).toBeNull();
    expect(tab2.get(8n, A, "entry")).toBeNull();
    tab2.clear(7n, A, "entry");
    expect(tab1.get(7n, A, "entry")).toBeNull();
  });

  it("an Arena claim and a market claim do not see or clear each other", () => {
    const s = createInflightStore(new MemoryKV(), 84532, () => 1);
    s.set(7n, A, "arena-claim", { action: "arena:claim", label: "Claim your points", hash: H });
    expect(s.get(7n, A, "market")).toBeNull();
    s.set(7n, A, "market", { action: "market:claim", label: "Claim", hash: H2 });
    s.clear(7n, A, "market");
    expect(s.get(7n, A, "arena-claim")).toMatchObject({ hash: H });
    expect(s.get(7n, A, "market")).toBeNull();
  });

  it("forgets a record after the TTL (a dropped transaction must not block forever)", () => {
    const kv = new MemoryKV();
    let now = 0;
    const s = createInflightStore(kv, 84532, () => now);
    s.set(7n, A, "arena-claim", { action: "claim", label: "Claim", hash: H });
    now = INFLIGHT_TTL_MS - 1;
    expect(s.get(7n, A, "arena-claim")).not.toBeNull();
    now = INFLIGHT_TTL_MS + 1;
    expect(s.get(7n, A, "arena-claim")).toBeNull();
    expect(kv.getItem(inflightKey(84532, 7n, A, "arena-claim"))).toBeNull();
  });

  it("treats damaged storage as no record, and refuses a bad hash", () => {
    const kv = new MemoryKV();
    const s = createInflightStore(kv, 84532, () => 1);
    kv.setItem(inflightKey(84532, 7n, A, "entry"), "{not json");
    expect(s.get(7n, A, "entry")).toBeNull();
    kv.setItem(inflightKey(84532, 7n, A, "entry"), JSON.stringify({ action: "x", label: "y", hash: "0x12", at: 1 }));
    expect(s.get(7n, A, "entry")).toBeNull();
  });

  it("survives storage that throws, and reports that nothing was stored", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const s = createInflightStore(broken, 84532, () => 1);
    expect(s.get(7n, A, "entry")).toBeNull();
    expect(s.set(7n, A, "entry", { action: "x", label: "y", hash: H })).toBe(false);
    expect(() => s.clear(7n, A, "entry")).not.toThrow();
    const none = createInflightStore(null, 84532, () => 1);
    expect(none.get(7n, A, "entry")).toBeNull();
    expect(none.set(7n, A, "entry", { action: "x", label: "y", hash: H })).toBe(false);
  });
});
