import { describe, expect, it } from "vitest";
import {
  compilesAsConditionRegex,
  isValidHeaderName,
} from "./condition-syntax";

describe("isValidHeaderName", () => {
  it("accepts a plain token", () => {
    expect(isValidHeaderName("X-Api-Key")).toBe(true);
    expect(isValidHeaderName("content-type")).toBe(true);
  });

  it("accepts RFC 9110 token special characters", () => {
    expect(isValidHeaderName("X-Custom!#$%&'*+-.^_`|~123")).toBe(true);
  });

  it("rejects an embedded space", () => {
    expect(isValidHeaderName("X Api Key")).toBe(false);
  });

  it("rejects trailing whitespace", () => {
    expect(isValidHeaderName("X-Api-Key ")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidHeaderName("")).toBe(false);
  });

  it("rejects a colon (not a token character)", () => {
    expect(isValidHeaderName("X-Api:Key")).toBe(false);
  });
});

describe("compilesAsConditionRegex", () => {
  it("accepts a plain pattern", () => {
    expect(compilesAsConditionRegex("^foo.*bar$")).toBe(true);
  });

  it("rejects an unbalanced group", () => {
    expect(compilesAsConditionRegex("(unterminated")).toBe(false);
  });

  it("normalizes a standalone inline flag group (?i) before compiling", () => {
    expect(compilesAsConditionRegex("(?i)foo")).toBe(true);
  });

  it("normalizes a scoped flag group (?i:...) into a plain group", () => {
    expect(compilesAsConditionRegex("(?i:foo)bar")).toBe(true);
  });

  it("normalizes a Rust named group (?P<name>...) into JS syntax", () => {
    expect(compilesAsConditionRegex("(?P<name>foo)")).toBe(true);
  });

  it("still rejects genuinely invalid syntax after normalization", () => {
    expect(compilesAsConditionRegex("(?i)[unterminated")).toBe(false);
  });
});
