import { describe, expect, it } from "vitest";
import { listingId, parseListingId, sameListing } from "../src/identity.js";

describe("listingId identity attribution", () => {
  it("is deterministic for same source fields", () => {
    const a = listingId({
      provider: "collectorcrypt",
      platform: "courtyard",
      nativeId: "fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    });
    const b = listingId({
      provider: "collectorcrypt",
      platform: "Courtyard",
      nativeId: "fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    });
    expect(a).toBe(b);
    expect(a).toBe(
      "collectorcrypt:courtyard:fcc81a2b-4d14-5122-8ccd-6bc916a59536",
    );
  });

  it("differs across platforms with same native uuid", () => {
    const courtyard = listingId({
      provider: "fixture",
      platform: "courtyard",
      nativeId: "same-uuid",
    });
    const cc = listingId({
      provider: "fixture",
      platform: "cc",
      nativeId: "same-uuid",
    });
    expect(courtyard).not.toBe(cc);
  });

  it("does not use array index", () => {
    const id = listingId({
      provider: "magiceden",
      platform: "me",
      nativeId: "token-abc",
    });
    expect(id.includes("0")).toBe(false);
    expect(id).toBe("magiceden:me:token-abc");
  });

  it("round-trips parseListingId", () => {
    const id = listingId({
      provider: "phygitals",
      platform: "phy",
      nativeId: "x:y:z",
    });
    const parts = parseListingId(id);
    expect(parts.provider).toBe("phygitals");
    expect(parts.platform).toBe("phy");
    expect(parts.nativeId).toBe("x:y:z");
  });

  it("sameListing compares identity parts", () => {
    expect(
      sameListing(
        { provider: "collectorcrypt", platform: "cc", nativeId: "1" },
        { provider: "collectorcrypt", platform: "CC", nativeId: "1" },
      ),
    ).toBe(true);
  });

  it("different providers with same platform/native stay distinct", () => {
    const a = listingId({
      provider: "collectorcrypt",
      platform: "cc",
      nativeId: "id-1",
    });
    const b = listingId({
      provider: "magiceden",
      platform: "cc",
      nativeId: "id-1",
    });
    expect(a).not.toBe(b);
  });
});
