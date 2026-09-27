import { describe, it, expect } from "vitest";
import { maskSecret } from "./mask-secret";

describe("maskSecret", () => {
  it("masks a short value whole rather than revealing most of it", () => {
    expect(maskSecret("short")).toBe("•".repeat(8));
    expect(maskSecret("1234567890")).toBe("•".repeat(8));
  });

  it("keeps a prefix and suffix visible for a long value", () => {
    const value = "oc_1234567890abcdefghijklmnop";
    expect(maskSecret(value)).toBe(
      `${value.slice(0, 6)}${"•".repeat(12)}${value.slice(-4)}`,
    );
  });

  it("never includes the full raw value in its output", () => {
    const value = "oc_supersecretvaluethatmustneverleak";
    expect(maskSecret(value)).not.toContain(value);
  });
});
