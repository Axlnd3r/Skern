import { describe, expect, it, vi } from "vitest";
import type { Path } from "../../../shared/score";
import { DEFAULT_KEEPER_URL, keeperUrlFromEnv, parseKeeperUrl, postReveal, relayText, type RelayOutcome } from "./relayClient";

const PATH: Path = [
  { close: 10, high: 20, low: -5 },
  { close: 5, high: 30, low: -10 },
  { close: 0, high: 12, low: -12 },
];
const WHO = "0x48090D421F8B220431e46C6F05723C1C87710730" as const;
const SALT = `0x${"ab".repeat(32)}` as const;
const TX = `0x${"cd".repeat(32)}`;
const REQ = { id: 12n, who: WHO, path: PATH, salt: SALT };

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(r: Response | Error): Promise<RelayOutcome> {
  const fetchFn = vi.fn(async () => {
    if (r instanceof Error) throw r;
    return r;
  });
  return postReveal({ fetch: fetchFn as unknown as typeof fetch, baseUrl: "http://k.test:8787", timeoutMs: 1000 }, REQ);
}

describe("parseKeeperUrl", () => {
  it("defaults to the local keeper when unset or empty", () => {
    expect(parseKeeperUrl(undefined)).toBe(DEFAULT_KEEPER_URL);
    expect(parseKeeperUrl("")).toBe(DEFAULT_KEEPER_URL);
    expect(DEFAULT_KEEPER_URL).toBe("http://127.0.0.1:8787");
  });
  it("in a production build an unset or empty URL means not configured, never localhost", () => {
    expect(parseKeeperUrl(undefined, true)).toBeUndefined();
    expect(parseKeeperUrl("", true)).toBeUndefined();
    expect(parseKeeperUrl("   ", true)).toBeUndefined();
    expect(parseKeeperUrl("https://keeper.example.org/", true)).toBe("https://keeper.example.org");
    expect(parseKeeperUrl(undefined, false)).toBe(DEFAULT_KEEPER_URL);
  });
  it("keeperUrlFromEnv: the localhost default only outside production", () => {
    expect(keeperUrlFromEnv(undefined, "development")).toBe(DEFAULT_KEEPER_URL);
    expect(keeperUrlFromEnv(undefined, "test")).toBe(DEFAULT_KEEPER_URL);
    expect(keeperUrlFromEnv(undefined, undefined)).toBe(DEFAULT_KEEPER_URL);
    expect(keeperUrlFromEnv(undefined, "production")).toBeUndefined();
    expect(keeperUrlFromEnv("", "production")).toBeUndefined();
    expect(keeperUrlFromEnv("https://k.example.org", "production")).toBe("https://k.example.org");
  });
  it("with no relay configured the post is 'unavailable' and nothing is fetched (manual reveal stays the fallback)", async () => {
    const fetchFn = vi.fn();
    const out = await postReveal({ fetch: fetchFn as unknown as typeof fetch, baseUrl: keeperUrlFromEnv(undefined, "production"), timeoutMs: 1000 }, REQ);
    expect(out.state).toBe("unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("accepts http and https and drops a trailing slash, query and hash", () => {
    expect(parseKeeperUrl("https://keeper.example.org/")).toBe("https://keeper.example.org");
    expect(parseKeeperUrl("http://host:9000/relay/?x=1#y")).toBe("http://host:9000/relay");
  });
  it("rejects other schemes, credentials and garbage (set but malformed means not configured)", () => {
    expect(parseKeeperUrl("ftp://x.example")).toBeUndefined();
    expect(parseKeeperUrl("javascript:alert(1)")).toBeUndefined();
    expect(parseKeeperUrl("https://user:pw@x.example")).toBeUndefined();
    expect(parseKeeperUrl("not a url")).toBeUndefined();
  });
});

describe("postReveal request", () => {
  it("POSTs JSON {id, who, path, salt} to /reveal with a decimal string id", async () => {
    const fetchFn = vi.fn(async () => reply(200, { ok: true, code: "REVEALED", message: "revealed", tx: TX }));
    await postReveal({ fetch: fetchFn as unknown as typeof fetch, baseUrl: "http://k.test:8787", timeoutMs: 1000 }, REQ);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://k.test:8787/reveal");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ id: "12", who: WHO, salt: SALT, path: PATH });
    expect(init.credentials).toBe("omit");
  });
  it("is unavailable, without calling fetch, when the keeper URL is not configured", async () => {
    const fetchFn = vi.fn();
    const out = await postReveal({ fetch: fetchFn as unknown as typeof fetch, baseUrl: undefined, timeoutMs: 1000 }, REQ);
    expect(out.state).toBe("unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("postReveal outcomes (keeper/src/relay.ts codes)", () => {
  it("200 REVEALED and ALREADY_REVEALED are revealed", async () => {
    expect(await run(reply(200, { ok: true, code: "REVEALED", message: "revealed", tx: TX }))).toEqual({ state: "revealed", code: "REVEALED", tx: TX });
    expect((await run(reply(200, { ok: true, code: "ALREADY_REVEALED", message: "x" }))).state).toBe("revealed");
  });
  it("202 QUEUED is queued and 202 PENDING is pending (in progress, not a failure)", async () => {
    expect(await run(reply(202, { ok: true, code: "QUEUED", message: "queued" }))).toEqual({ state: "queued" });
    expect(await run(reply(202, { ok: true, code: "PENDING", message: "p", tx: TX }))).toEqual({ state: "pending", tx: TX });
    expect(await run(reply(202, { ok: true, code: "PENDING", message: "p" }))).toEqual({ state: "pending" });
  });
  it("drops a tx value that is not a 32-byte hash", async () => {
    expect(await run(reply(202, { ok: true, code: "PENDING", message: "p", tx: "<script>" }))).toEqual({ state: "pending" });
  });
  it("terminal refusals are rejected with a code", async () => {
    for (const [status, code] of [
      [409, "WRONG_WINDOW"],
      [409, "NO_COMMIT"],
      [422, "HASH_MISMATCH"],
      [422, "INVALID_PATH"],
      [403, "AGENT_NOT_RELAYED"],
      [404, "UNKNOWN_ROUND"],
      [400, "BAD_REQUEST"],
    ] as const) {
      const out = await run(reply(status, { ok: false, code, message: "relay text" }));
      expect(out.state).toBe("rejected");
      if (out.state === "rejected") expect(out.code).toBe(code);
    }
  });
  it("transient refusals are retry", async () => {
    for (const [status, code] of [
      [429, "RATE_LIMITED"],
      [503, "BUSY"],
      [503, "RPC_ERROR"],
      [503, "QUEUE_FULL"],
      [502, "REVEAL_FAILED"],
      [409, "IN_FLIGHT"],
    ] as const) {
      expect((await run(reply(status, { ok: false, code, message: "x" }))).state).toBe("retry");
    }
  });
  it("a network error or timeout is unavailable and says to use the manual reveal", async () => {
    const out = await run(new TypeError("Failed to fetch"));
    expect(out.state).toBe("unavailable");
    expect(relayText(out)).toMatch(/manual|yourself|reveal/i);
  });
  it("never fakes success from an unknown or malformed answer", async () => {
    expect((await run(reply(200, "not json"))).state).toBe("unavailable");
    expect((await run(reply(200, { ok: true, code: "SOMETHING_NEW", message: "x" }))).state).toBe("unavailable");
    expect((await run(reply(200, { ok: false, code: "REVEALED", message: "x" }))).state).not.toBe("revealed");
    expect((await run(reply(200, [1, 2]))).state).toBe("unavailable");
    expect((await run(reply(500, { ok: false, code: "INTERNAL", message: "x" }))).state).toBe("retry");
  });
  it("shows our own text, never the relay's free text", async () => {
    const out = await run(reply(422, { ok: false, code: "HASH_MISMATCH", message: "ATTACKER <b>TEXT</b>" }));
    expect(relayText(out)).not.toMatch(/ATTACKER/);
    expect(relayText(out)).toMatch(/do not match/i);
  });
});

describe("relayText", () => {
  it("has plain text for every outcome", () => {
    const outs: RelayOutcome[] = [
      { state: "revealed", code: "REVEALED" },
      { state: "queued" },
      { state: "pending" },
      { state: "rejected", code: "WRONG_WINDOW", message: "" },
      { state: "retry", message: "Try again shortly." },
      { state: "unavailable", message: "Not reachable." },
    ];
    for (const o of outs) expect(relayText(o).length).toBeGreaterThan(10);
  });
});
