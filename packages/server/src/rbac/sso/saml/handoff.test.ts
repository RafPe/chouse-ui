import { describe, it, expect } from "bun:test";
import { stashTokens, claimTokens, markAssertionSeen } from "./handoff";

const payload = { user: { id: "u1" } as never, tokens: { accessToken: "a" } as never, redirect: "/dash" };

describe("token handoff", () => {
  it("returns the payload exactly once, then null (single-use)", () => {
    const code = stashTokens(payload, 60_000, new Date(0));
    expect(claimTokens(code, new Date(1_000))?.redirect).toBe("/dash");
    expect(claimTokens(code, new Date(2_000))).toBeNull();
  });
  it("expires after TTL", () => {
    const code = stashTokens(payload, 60_000, new Date(0));
    expect(claimTokens(code, new Date(61_000))).toBeNull();
  });
  it("returns null for an unknown code", () => {
    expect(claimTokens("nope", new Date(0))).toBeNull();
  });
});

describe("replay cache", () => {
  it("accepts an assertion id once, rejects the second time", () => {
    expect(markAssertionSeen("_a1", new Date(60_000), new Date(0))).toBe(true);
    expect(markAssertionSeen("_a1", new Date(60_000), new Date(1_000))).toBe(false);
  });
  it("forgets ids past their notOnOrAfter (sweep)", () => {
    expect(markAssertionSeen("_a2", new Date(1_000), new Date(0))).toBe(true);
    // after _a2 expired, a later assertion with a fresh id triggers sweep; _a2 can be reused
    expect(markAssertionSeen("_a3", new Date(120_000), new Date(2_000))).toBe(true);
    expect(markAssertionSeen("_a2", new Date(180_000), new Date(2_000))).toBe(true);
  });
});
