// A real key was nearly committed once: every secret-looking variable of .env.example must have an empty value.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");

describe("keeper/.env.example", () => {
  // `NAME=value` or `# NAME=value` where NAME ends in _KEY, _SECRET or is PRIVATE_KEY / contains it
  const assignments = text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1] as string, value: (m[2] as string).trim() }));
  const secrets = assignments.filter((a) => /(_KEY|_SECRET|PRIVATE_KEY)$/.test(a.name));

  it("lists the secret variables it is supposed to guard", () => {
    const names = secrets.map((s) => s.name);
    expect(names).toContain("KEEPER_PRIVATE_KEY");
    expect(names).toContain("TWELVEDATA_API_KEY");
  });

  it("has an empty value for every *_KEY, *_SECRET and PRIVATE_KEY line", () => {
    for (const s of secrets) expect(`${s.name}=${s.value}`).toBe(`${s.name}=`);
  });

  it("names no Alpaca variable any more", () => {
    expect(assignments.map((a) => a.name).filter((n) => n.startsWith("APCA_"))).toEqual([]);
  });
});
