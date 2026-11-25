import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { Path } from "../../shared/score";
import { SaltError, SaltStore, hashPath, saltFileName, type SaltKey } from "../src/salt";

const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const WHO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const PATH: Path = [
  { close: 10, high: 12, low: -2 },
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];
const key = (id: bigint, who: Address = WHO): SaltKey => ({ chainId: 31337, arena: ARENA, id, who });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "salt-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SaltStore", () => {
  it("create writes a durable record with the hash of path, salt and who", () => {
    const store = new SaltStore(dir);
    const rec = store.create(key(1n), PATH);
    expect(rec.status).toBe("pending");
    expect(rec.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rec.hash).toBe(hashPath(PATH, rec.salt, WHO));
    const onDisk = JSON.parse(readFileSync(join(dir, saltFileName(key(1n))), "utf8"));
    expect(onDisk.salt).toBe(rec.salt);
    expect(onDisk.hash).toBe(rec.hash);
    expect(onDisk.id).toBe("1");
    expect(onDisk.path).toEqual(PATH);
  });

  it("a new store instance on the same directory reads the same record (survives a restart)", () => {
    const a = new SaltStore(dir);
    const rec = a.create(key(7n), PATH);
    a.update(key(7n), { status: "committed", commitTx: `0x${"ab".repeat(32)}` });
    const b = new SaltStore(dir);
    const got = b.get(key(7n));
    expect(got?.salt).toBe(rec.salt);
    expect(got?.status).toBe("committed");
    expect(got?.commitTx).toBe(`0x${"ab".repeat(32)}`);
    expect(got?.path).toEqual(PATH);
    expect(b.get(key(8n))).toBeUndefined();
  });

  it("never overwrites an existing record: a second create for the same key throws and keeps the first salt", () => {
    const store = new SaltStore(dir);
    const first = store.create(key(1n), PATH);
    expect(() => store.create(key(1n), PATH)).toThrowError(expect.objectContaining({ code: "SALT_EXISTS" }));
    expect(store.get(key(1n))?.salt).toBe(first.salt);
  });

  it("leaves no temp files behind and ignores leftover temp files", () => {
    const store = new SaltStore(dir);
    store.create(key(1n), PATH);
    store.update(key(1n), { status: "committed" });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // a crash between the temp write and the link leaves a *.tmp file: it must not count as a record
    writeFileSync(join(dir, saltFileName(key(2n)) + ".123.abc.tmp"), "{ half written");
    expect(store.list()).toHaveLength(1);
    expect(store.get(key(2n))).toBeUndefined();
    store.create(key(2n), PATH); // and the round can still be created
  });

  it("every record gets a distinct salt, and a salt already used in another round is never reused", () => {
    const store = new SaltStore(dir);
    const salts = new Set<string>();
    for (let id = 1n; id <= 20n; id++) salts.add(store.create(key(id), PATH).salt);
    expect(salts.size).toBe(20);

    // A broken RNG that repeats its output must not produce a second record with the same salt.
    const same = new Uint8Array(32).fill(7);
    let calls = 0;
    const dir2 = mkdtempSync(join(tmpdir(), "salt-test-"));
    try {
      const rigged = new SaltStore(dir2, {
        randomBytes: (n) => {
          calls++;
          return calls <= 2 ? same : new Uint8Array(n).fill(9);
        },
      });
      const r1 = rigged.create(key(1n), PATH);
      const r2 = rigged.create(key(2n), PATH);
      expect(r1.salt).toBe(`0x${"07".repeat(32)}`);
      expect(r2.salt).not.toBe(r1.salt);
      expect(r2.salt).toBe(`0x${"09".repeat(32)}`);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("separates records by address and by chain", () => {
    const store = new SaltStore(dir);
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
    const a = store.create(key(1n), PATH);
    const b = store.create(key(1n, other), PATH);
    const c = store.create({ ...key(1n), chainId: 84532 }, PATH);
    expect(new Set([a.salt, b.salt, c.salt]).size).toBe(3);
    expect(store.list({ chainId: 31337, arena: ARENA, who: other })).toHaveLength(1);
    expect(store.list({ chainId: 31337, arena: ARENA, who: WHO })).toHaveLength(1);
  });

  it("a corrupt file is reported and never replaced", () => {
    const store = new SaltStore(dir);
    const rec = store.create(key(1n), PATH);
    const file = join(dir, saltFileName(key(1n)));
    const tampered = readFileSync(file, "utf8").replace(rec.salt.slice(2, 10), "deadbeef");
    writeFileSync(file, tampered);
    expect(() => store.get(key(1n))).toThrowError(expect.objectContaining({ code: "SALT_CORRUPT" }));
    expect(() => store.create(key(1n), PATH)).toThrowError(SaltError); // exists: still no overwrite
    expect(readFileSync(file, "utf8")).toBe(tampered);

    writeFileSync(file, "not json");
    expect(() => store.get(key(1n))).toThrowError(expect.objectContaining({ code: "SALT_CORRUPT" }));
    expect(readFileSync(file, "utf8")).toBe("not json");
  });

  it("an unreadable file is skipped (and reported) by list(onCorrupt) and by create, but list() without a callback stays strict", () => {
    const warnings: string[] = [];
    const store = new SaltStore(dir, { warn: (m) => warnings.push(m) });
    const good = store.create(key(1n), PATH);
    writeFileSync(join(dir, "garbage.salt.json"), "not json");
    writeFileSync(join(dir, "31337-0xabc-1-0xdef.salt.json"), "{}");

    expect(() => store.list()).toThrowError(expect.objectContaining({ code: "SALT_CORRUPT" }));
    const skipped: string[] = [];
    const seen = store.list(undefined, (file) => skipped.push(file));
    expect(seen.map((r) => r.salt)).toEqual([good.salt]);
    expect(skipped.sort()).toEqual(["31337-0xabc-1-0xdef.salt.json", "garbage.salt.json"]);

    const next = store.create(key(2n), PATH); // not blocked by the bad files
    expect(next.salt).not.toBe(good.salt);
    expect(warnings.join(" ")).toMatch(/garbage.salt.json/);
    expect(readFileSync(join(dir, "garbage.salt.json"), "utf8")).toBe("not json"); // never modified
  });

  it("update cannot change salt, path or hash", () => {
    const store = new SaltStore(dir);
    const rec = store.create(key(1n), PATH);
    const upd = store.update(key(1n), { status: "revealed", revealTx: `0x${"cd".repeat(32)}` });
    expect(upd.salt).toBe(rec.salt);
    expect(upd.hash).toBe(rec.hash);
    expect(store.get(key(1n))?.status).toBe("revealed");
    expect(() => store.update(key(9n), { status: "committed" })).toThrowError(expect.objectContaining({ code: "SALT_NOT_FOUND" }));
  });
});

describe("hashPath", () => {
  it("depends on every input", () => {
    const salt = `0x${"11".repeat(32)}` as const;
    const base = hashPath(PATH, salt, WHO);
    expect(hashPath(PATH, salt, WHO)).toBe(base);
    expect(hashPath(PATH, `0x${"12".repeat(32)}`, WHO)).not.toBe(base);
    expect(hashPath(PATH, salt, ARENA)).not.toBe(base);
    expect(hashPath([PATH[0], PATH[1], { close: 30, high: 32, low: 17 }], salt, WHO)).not.toBe(base);
  });
});
