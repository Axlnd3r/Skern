import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA_CHAIN_ID, CHAIN, arenaAbi, parseAddress, parseAddresses } from "./chain";
import { HOUSE_AGENTS, HOUSE_HEADING, HOUSE_LABEL, HOUSE_NOTE, NO_ENDORSEMENT, US_NOTICE } from "./disclaimer";

const ADDR = "0x1111111111111111111111111111111111111111";

describe("chain config", () => {
  it("targets Base Sepolia (84532) only", () => {
    expect(CHAIN.id).toBe(84532);
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
  });
  it("uses the shared Arena ABI", () => {
    const names = arenaAbi.flatMap((x) => ("name" in x ? [x.name] : []));
    expect(names).toContain("getRound");
    expect(names).toContain("isVoid");
  });
});

describe("parseAddress", () => {
  it("accepts a well-formed address and trims whitespace", () => {
    expect(parseAddress(` ${ADDR} `)).toBe(ADDR);
  });
  it("rejects missing, short and non-hex values", () => {
    expect(parseAddress(undefined)).toBeUndefined();
    expect(parseAddress("")).toBeUndefined();
    expect(parseAddress("0x1234")).toBeUndefined();
    expect(parseAddress("not-an-address")).toBeUndefined();
  });
  it("maps env keys to addresses", () => {
    expect(parseAddresses({ arena: ADDR, points: "bad" })).toEqual({
      arena: ADDR,
      points: undefined,
      registry: undefined,
      gapMarket: undefined,
    });
  });
});

describe("disclaimer", () => {
  it("states testnet, points only, US-user notice and no endorsement", () => {
    expect(US_NOTICE).toMatch(/testnet/i);
    expect(US_NOTICE).toMatch(/points only/i);
    expect(US_NOTICE).toMatch(/US users/);
    expect(US_NOTICE).toMatch(/not investment advice/i);
    expect(NO_ENDORSEMENT).toMatch(/not endorsed by Base/i);
  });
  it("labels house agents", () => {
    expect(HOUSE_LABEL).toBe("house");
    expect(HOUSE_AGENTS.length).toBe(3);
  });
});

describe("house agent list", () => {
  it("is not worded as per-round data", () => {
    expect(HOUSE_HEADING).not.toMatch(/in this round/i);
    expect(HOUSE_HEADING).toMatch(/house/i);
    expect(HOUSE_NOTE).toMatch(/static/i);
    expect(HOUSE_NOTE).not.toMatch(/in this round/i);
  });
});
