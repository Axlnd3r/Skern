// The commit hash, a pure re-implementation of `Arena.hashPath`: keccak256(abi.encode(path, salt, who)).
// `who` is the address that sends `commit`. The encoding types are read from the shared ABI, so a changed
// contract signature fails loudly at load time instead of producing hashes the contract rejects. The test
// checks fixtures produced by the deployed contract. This is NOT scoring: no score logic lives here.

import { bytesToHex, encodeAbiParameters, getAddress, isHex, keccak256, size, type Address, type Hex } from "viem";
import type { Path } from "../../../shared/score";
import { arenaAbi } from "./chain";

type AbiParam = { name: string; type: string; components?: AbiParam[] };

function hashInputs(): AbiParam[] {
  const fn = arenaAbi.find((x) => x.type === "function" && x.name === "hashPath") as { inputs: AbiParam[] } | undefined;
  const types = fn?.inputs.map((i) => i.type).join(",");
  if (!fn || types !== "tuple[3],bytes32,address") {
    throw new Error(`Arena ABI: hashPath inputs changed (${types ?? "missing"}); update app/src/lib/commitHash.ts`);
  }
  return fn.inputs;
}

const INPUTS = hashInputs();

/** `keccak256(abi.encode(path, salt, who))`, identical to `Arena.hashPath`. Throws on a malformed salt or address. */
export function commitHash(path: Path, salt: Hex, who: Address): Hex {
  if (!isHex(salt) || size(salt) !== 32) throw new RangeError("salt must be 32 bytes");
  const p = path.map((c) => ({ close: c.close, high: c.high, low: c.low }));
  return keccak256(encodeAbiParameters(INPUTS as never, [p, salt, getAddress(who)] as never));
}

const browserRandom = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** 32 random bytes from `crypto.getRandomValues` (or the injected source in tests), as 0x hex. Never all zero. */
export function newSalt(random: (n: number) => Uint8Array = browserRandom): Hex {
  const bytes = random(32);
  if (bytes.length !== 32) throw new RangeError("random source must return 32 bytes");
  if (bytes.every((b) => b === 0)) throw new RangeError("random source returned only zeros");
  return bytesToHex(bytes);
}
