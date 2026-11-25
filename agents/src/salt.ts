// Salt persistence for commit-reveal, and the commit hash.
//
// Safety model
//  - A salt file is the only copy of the secret needed to reveal. It is written BEFORE the commit transaction
//    is sent, atomically (temp file, fsync, then a hard link to the final name: the link fails with EEXIST if a
//    record already exists, so an existing salt is never overwritten by `create`).
//  - Later state changes (`update`) replace the file atomically (temp file, fsync, rename). salt, path, hash and
//    the key never change after creation.
//  - One record per (chainId, arena, round id, committing address). A fresh random salt is drawn for every
//    record and is also checked against every other record in the directory, so a salt is never reused across
//    rounds.
//  - Files hold the salt in clear text (it is not a wallet key, and it is only secret until the reveal window).
//    They are created mode 0600 in a 0700 directory. The wallet key is never written here.
import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { bytesToHex, encodeAbiParameters, getAddress, isAddress, isHex, keccak256, size, type Abi, type Address, type Hex } from "viem";
import type { Candle, Path } from "../../shared/score";

// ---------------------------------------------------------------------------------------------- ABI

/** Loads `shared/abi/<name>.json` (the only source of contract ABIs). */
export function loadAbi(name: string): Abi {
  const raw = JSON.parse(readFileSync(new URL(`../../shared/abi/${name}.json`, import.meta.url), "utf8")) as unknown;
  const abi = Array.isArray(raw) ? raw : (raw as { abi?: unknown }).abi;
  if (!Array.isArray(abi)) throw new Error(`shared/abi/${name}.json: no ABI array`);
  return abi as Abi;
}

interface AbiParam {
  name: string;
  type: string;
  components?: AbiParam[];
}

/** Input types of `Arena.hashPath(Candle[3] path, bytes32 salt, address who)`, read from the ABI. */
function hashPathInputs(): AbiParam[] {
  const fn = loadAbi("Arena").find((x) => x.type === "function" && x.name === "hashPath") as { inputs: AbiParam[] } | undefined;
  const types = fn?.inputs.map((i) => i.type).join(",");
  if (!fn || types !== "tuple[3],bytes32,address") {
    throw new Error(`Arena ABI: hashPath inputs changed (${types ?? "missing"}); update agents/src/salt.ts`);
  }
  return fn.inputs;
}

const HASH_INPUTS = hashPathInputs();

/**
 * `keccak256(abi.encode(path, salt, who))`, identical to `Arena.hashPath`. `who` is the address that sends
 * `commit` (`msg.sender`). Pure; no RPC.
 */
export function hashPath(path: Path, salt: Hex, who: Address): Hex {
  const p = path.map((c) => ({ close: c.close, high: c.high, low: c.low }));
  return keccak256(encodeAbiParameters(HASH_INPUTS as never, [p, salt, who] as never));
}

// ---------------------------------------------------------------------------------------------- types

export type SaltStatus = "pending" | "committed" | "revealed";

export interface SaltKey {
  chainId: number;
  arena: Address;
  id: bigint;
  /** The committing address. */
  who: Address;
}

export interface SaltRecord extends SaltKey {
  version: 1;
  salt: Hex;
  path: Path;
  hash: Hex;
  /** `pending`: written before the commit tx; `committed`: commit confirmed; `revealed`: reveal confirmed. */
  status: SaltStatus;
  createdAt: number;
  commitTx?: Hex;
  revealTx?: Hex;
}

export class SaltError extends Error {
  constructor(
    readonly code: "SALT_EXISTS" | "SALT_CORRUPT" | "SALT_NOT_FOUND" | "SALT_IO",
    message: string,
  ) {
    super(message);
    this.name = "SaltError";
  }
}

export interface SaltStoreOptions {
  /** Injectable randomness (tests). Must return `n` unpredictable bytes. */
  randomBytes?: (n: number) => Uint8Array;
  /** Injectable clock, unix seconds (stored as `createdAt`). */
  nowSec?: () => number;
  /** Where skipped-file warnings go (default: stderr). */
  warn?: (msg: string) => void;
}

// ---------------------------------------------------------------------------------------------- store

const FILE_SUFFIX = ".salt.json";

export function saltFileName(k: SaltKey): string {
  return `${k.chainId}-${k.arena.toLowerCase()}-${k.id.toString()}-${k.who.toLowerCase()}${FILE_SUFFIX}`;
}

function sameKey(a: SaltKey, b: SaltKey): boolean {
  return a.chainId === b.chainId && a.arena.toLowerCase() === b.arena.toLowerCase() && a.id === b.id && a.who.toLowerCase() === b.who.toLowerCase();
}

function snapshotPath(p: Path): Path {
  return p.map((c) => ({ close: c.close | 0, high: c.high | 0, low: c.low | 0 })) as unknown as Path;
}

function serialize(r: SaltRecord): string {
  return JSON.stringify({ ...r, id: r.id.toString() }, null, 2) + "\n";
}

function isInt32(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= -2147483648 && x <= 2147483647;
}

function parseRecord(text: string, file: string): SaltRecord {
  const bad = (why: string): never => {
    throw new SaltError("SALT_CORRUPT", `salt file ${file} is corrupt (${why}); it was NOT modified, inspect it by hand`);
  };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad("not JSON");
  }
  if (j === null || typeof j !== "object" || j.version !== 1) return bad("unknown version");
  const { chainId, arena, id, who, salt, hash, status, createdAt } = j;
  if (!Number.isSafeInteger(chainId) || typeof arena !== "string" || !isAddress(arena)) return bad("chain or arena");
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) return bad("id");
  if (typeof who !== "string" || !isAddress(who)) return bad("who");
  if (typeof salt !== "string" || !isHex(salt) || size(salt) !== 32) return bad("salt");
  if (typeof hash !== "string" || !isHex(hash) || size(hash) !== 32) return bad("hash");
  if (status !== "pending" && status !== "committed" && status !== "revealed") return bad("status");
  if (!Number.isSafeInteger(createdAt)) return bad("createdAt");
  const path = j.path as Candle[] | undefined;
  if (!Array.isArray(path) || path.length !== 3) return bad("path");
  for (const c of path) {
    if (c === null || typeof c !== "object" || !isInt32(c.close) || !isInt32(c.high) || !isInt32(c.low)) return bad("path");
  }
  const rec: SaltRecord = {
    version: 1,
    chainId: chainId as number,
    arena: getAddress(arena),
    id: BigInt(id),
    who: getAddress(who),
    salt: salt as Hex,
    path: snapshotPath(path as unknown as Path),
    hash: hash as Hex,
    status,
    createdAt: createdAt as number,
    ...(typeof j.commitTx === "string" && isHex(j.commitTx) ? { commitTx: j.commitTx } : {}),
    ...(typeof j.revealTx === "string" && isHex(j.revealTx) ? { revealTx: j.revealTx } : {}),
  };
  if (hashPath(rec.path, rec.salt, rec.who).toLowerCase() !== rec.hash.toLowerCase()) return bad("hash does not match path, salt and who");
  return rec;
}

/** fsyncs a directory so a rename or link survives power loss. Not possible on Windows (skipped). */
function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* some filesystems refuse directory fsync; the file itself was already fsynced */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes `data` to a fresh temp file next to `target` and fsyncs it. Returns the temp path. */
function writeTemp(target: string, data: string): string {
  const tmp = `${target}.${process.pid}.${nodeRandomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

export class SaltStore {
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly nowSec: () => number;
  private readonly warn: (msg: string) => void;

  constructor(
    readonly dir: string,
    opts: SaltStoreOptions = {},
  ) {
    this.randomBytes = opts.randomBytes ?? ((n) => nodeRandomBytes(n));
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.warn = opts.warn ?? ((m) => console.error(`[salt] ${m}`));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private fileOf(k: SaltKey): string {
    return join(this.dir, saltFileName(k));
  }

  /**
   * Creates the record for `key` with a fresh random salt, durably, and returns it. Throws SALT_EXISTS if a
   * record for the key already exists (the existing file is left untouched).
   */
  create(key: SaltKey, path: Path): SaltRecord {
    const p = snapshotPath(path);
    // A bad file elsewhere in the directory must not block a new commit: skip it (it is reported on stderr).
    const used = new Set(this.list(undefined, (f, why) => this.warn(`skipping unreadable salt file ${f}: ${why}`)).map((r) => r.salt.toLowerCase()));
    let salt: Hex | undefined;
    for (let i = 0; i < 8 && salt === undefined; i++) {
      const bytes = this.randomBytes(32);
      if (bytes.length !== 32) throw new SaltError("SALT_IO", "randomBytes must return 32 bytes");
      const candidate = bytesToHex(bytes);
      if (!used.has(candidate.toLowerCase()) && /[1-9a-f]/i.test(candidate.slice(2))) salt = candidate;
    }
    if (salt === undefined) throw new SaltError("SALT_IO", "could not draw an unused salt");
    const who = getAddress(key.who);
    const rec: SaltRecord = {
      version: 1,
      chainId: key.chainId,
      arena: getAddress(key.arena),
      id: key.id,
      who,
      salt,
      path: p,
      hash: hashPath(p, salt, who),
      status: "pending",
      createdAt: this.nowSec(),
    };
    const file = this.fileOf(rec);
    const tmp = writeTemp(file, serialize(rec));
    try {
      linkSync(tmp, file); // atomic and exclusive: fails if the record already exists
      fsyncDir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SaltError("SALT_EXISTS", `a salt record already exists for round ${key.id} (${file}); not overwriting`);
      }
      throw new SaltError("SALT_IO", `cannot create salt file: ${(e as Error).message}`);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* a leftover temp file is ignored by `list` and `get` */
      }
    }
    return rec;
  }

  /** The record for `key`, or undefined if none. A corrupt file throws SALT_CORRUPT and is never replaced. */
  get(key: SaltKey): SaltRecord | undefined {
    const file = this.fileOf(key);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SaltError("SALT_IO", `cannot read ${file}: ${(e as Error).message}`);
    }
    const rec = parseRecord(text, file);
    if (!sameKey(rec, key)) throw new SaltError("SALT_CORRUPT", `salt file ${file} holds a different round or address than its name says`);
    return rec;
  }

  /** Atomically replaces the mutable fields (status and transaction hashes) of an existing record. */
  update(key: SaltKey, patch: { status: SaltStatus; commitTx?: Hex; revealTx?: Hex }): SaltRecord {
    const cur = this.get(key);
    if (!cur) throw new SaltError("SALT_NOT_FOUND", `no salt record for round ${key.id}`);
    const next: SaltRecord = {
      ...cur,
      status: patch.status,
      ...(patch.commitTx ? { commitTx: patch.commitTx } : {}),
      ...(patch.revealTx ? { revealTx: patch.revealTx } : {}),
    };
    const file = this.fileOf(cur);
    const tmp = writeTemp(file, serialize(next));
    try {
      renameSync(tmp, file);
      fsyncDir(this.dir);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw new SaltError("SALT_IO", `cannot replace salt file: ${(e as Error).message}`);
    }
    return next;
  }

  /**
   * All records in the directory (optionally for one chain, arena and address). Without `onCorrupt` a bad file
   * throws; with it, the bad file is skipped (never modified) and reported, so one unreadable file cannot block
   * the others.
   */
  list(filter?: { chainId: number; arena: Address; who: Address }, onCorrupt?: (file: string, why: string) => void): SaltRecord[] {
    const out: SaltRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(FILE_SUFFIX)) continue; // temp files end in ".tmp"
      const file = join(this.dir, name);
      let rec: SaltRecord;
      try {
        rec = parseRecord(readFileSync(file, "utf8"), file);
        if (name !== saltFileName(rec)) throw new SaltError("SALT_CORRUPT", `salt file ${name} holds a different round or address than its name says`);
      } catch (e) {
        if (!onCorrupt) throw e;
        onCorrupt(name, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (
        filter &&
        !(rec.chainId === filter.chainId && rec.arena.toLowerCase() === filter.arena.toLowerCase() && rec.who.toLowerCase() === filter.who.toLowerCase())
      ) {
        continue;
      }
      out.push(rec);
    }
    return out;
  }
}
