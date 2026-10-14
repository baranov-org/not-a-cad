import { describe, expect, it } from "vitest";
import { isSessionId, newSessionId } from "../src";

describe("session id", () => {
  it("generates unique valid ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, newSessionId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isSessionId(id)).toBe(true);
  });
  it("rejects malformed ids", () => {
    for (const bad of ["", "short", "a".repeat(23), "a".repeat(21) + "/", "../" + "a".repeat(19), 42, null]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
});
