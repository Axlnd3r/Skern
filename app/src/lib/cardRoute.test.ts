import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/card/route";

const call = (q: string) => GET(new Request(`http://localhost/api/card${q}`));

describe("GET /api/card", () => {
  it("the card route returns a PNG with status 200", async () => {
    const res = await call("?me=87&agent=90&base=60&round=12&t=AAPL");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG signature
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("is a 1200x630 PNG, also with the longest allowed ticker and round, a tie and a zero score", async () => {
    const dims = async (q: string) => {
      const res = await call(q);
      expect(res.status).toBe(200);
      const b = new DataView((await res.arrayBuffer()).slice(0, 24));
      return [b.getUint32(16), b.getUint32(20)];
    };
    expect(await dims("?me=87&agent=90&base=60&round=12&t=AAPL")).toEqual([1200, 630]);
    expect(await dims("?me=100&agent=100&base=100&round=999999999&t=WWWWW")).toEqual([1200, 630]);
    expect(await dims("?me=0&agent=0&base=0&round=0")).toEqual([1200, 630]);
  });

  it("renders a win and a level card too", async () => {
    expect((await call("?me=95&agent=90")).status).toBe(200);
    expect((await call("?me=90&agent=90")).status).toBe(200);
  });

  it("rejects bad input with a fixed plain-text 400 that echoes nothing", async () => {
    const res = await call("?me=%3Cscript%3Ealert(1)%3C/script%3E&agent=90");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).not.toContain("script");
    expect(body).not.toContain("alert");
  });

  it("rejects unknown parameters with the fixed 400 and caches a valid card", async () => {
    const bad = await call("?me=87&agent=90&cachebust=1");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("Invalid card parameters.");
    const ok = await call("?me=87&agent=90");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=3600");
  });

  it("rejects a missing score and out-of-range numbers", async () => {
    expect((await call("")).status).toBe(400);
    expect((await call("?me=101&agent=90")).status).toBe(400);
    expect((await call("?me=87&agent=9999999999")).status).toBe(400);
  });
});
