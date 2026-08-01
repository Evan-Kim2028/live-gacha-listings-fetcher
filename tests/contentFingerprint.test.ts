import { describe, expect, it } from "vitest";
import { contentFingerprint } from "../src/contentFingerprint.js";

describe("contentFingerprint", () => {
  it("is stable for same rows regardless of order", () => {
    const a = contentFingerprint([
      { id: "b", price: 2, listedAt: "t" },
      { id: "a", price: 1, listedAt: null },
    ]);
    const b = contentFingerprint([
      { id: "a", price: 1, listedAt: null },
      { id: "b", price: 2, listedAt: "t" },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^fp:[0-9a-f]{8}$/);
  });

  it("changes when price changes", () => {
    const a = contentFingerprint([{ id: "x", price: 1 }]);
    const b = contentFingerprint([{ id: "x", price: 2 }]);
    expect(a).not.toBe(b);
  });

  it("empty set is stable", () => {
    expect(contentFingerprint([])).toBe("fp:empty");
  });
});
