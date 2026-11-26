import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { commitHash, newSalt } from "./commitHash";

// Fixtures: output of `cast call <Arena on Base Sepolia> "hashPath((int32,int32,int32)[3],bytes32,address)(bytes32)"`
// for the same inputs (the contract is the reference, not this app).
const S1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const S2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const W1 = "0x48090D421F8B220431e46C6F05723C1C87710730";
const W2 = "0x92881Ced4E598ee1b476A6066b41f7ac7213346e";

const FLAT: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];
const MIXED: Path = [
  { close: 50, high: 80, low: -10 },
  { close: -20, high: 60, low: -45 },
  { close: 70, high: 90, low: -2147483648 },
];
const EXTREME: Path = [
  { close: 120, high: 150, low: -30 },
  { close: -300, high: -100, low: -400 },
  { close: 2147483647, high: 2147483647, low: 0 },
];

describe("commitHash (same encoding as Arena.hashPath)", () => {
  it("matches the contract for a flat path", () => {
    expect(commitHash(FLAT, S1, W1)).toBe("0x482f04d8b9c7879f1955542ecec8b71eabd507ab8db596cd7cae6f67cbe7535f");
  });
  it("matches the contract for negative and int32-min values", () => {
    expect(commitHash(MIXED, S2, W2)).toBe("0x21fa96f72e14ee032d5abc3ce4b243b8ad9d9a7d2490064f7344aeef17392315");
  });
  it("matches the contract for int32-max values", () => {
    expect(commitHash(EXTREME, S1, W2)).toBe("0x1e1e8a164be8c00ee42b6707cd6fc4e08b5ba3b54a2144373e66086dc5f3a7a7");
  });
  it("binds the committing address and the salt", () => {
    expect(commitHash(FLAT, S1, W2)).not.toBe(commitHash(FLAT, S1, W1));
    expect(commitHash(FLAT, S2, W1)).not.toBe(commitHash(FLAT, S1, W1));
  });
  it("ignores the letter case of the address", () => {
    expect(commitHash(FLAT, S1, W1.toLowerCase() as `0x${string}`)).toBe(commitHash(FLAT, S1, W1));
  });
  it("rejects a salt that is not 32 bytes", () => {
    expect(() => commitHash(FLAT, "0x1234", W1)).toThrow();
  });
});

describe("newSalt", () => {
  it("is 32 random bytes as 0x hex, from the injected source", () => {
    const bytes = new Uint8Array(32).map((_, i) => i + 1);
    const s = newSalt((n) => bytes.slice(0, n));
    expect(s).toBe("0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
  });
  it("refuses a source that returns the wrong length or all zeros", () => {
    expect(() => newSalt(() => new Uint8Array(16))).toThrow();
    expect(() => newSalt((n) => new Uint8Array(n))).toThrow();
  });
  it("two draws from the real source differ", () => {
    expect(newSalt()).not.toBe(newSalt());
  });
});
