import { describe, expect, it } from "vitest";

import { ruleConditionSchema } from "./policy-rule";

const accepts = (condition: unknown) =>
  ruleConditionSchema.safeParse(condition).success;

const issues = (condition: unknown) => {
  const result = ruleConditionSchema.safeParse(condition);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("ruleConditionSchema — legacy shape", () => {
  it("keeps the original {target: body, operator: contains, value} shape valid", () => {
    expect(
      accepts({ target: "body", operator: "contains", value: "foo" }),
    ).toBe(true);
  });
});

describe("ruleConditionSchema — (target, operator) matrix", () => {
  // body: contains/equals/regex require a value; exists is header-only.
  it.each(["contains", "equals", "regex"] as const)(
    "body + %s with a value is valid",
    (operator) => {
      expect(accepts({ target: "body", operator, value: "x" })).toBe(true);
    },
  );

  it("body + exists is rejected (exists is header-only)", () => {
    expect(accepts({ target: "body", operator: "exists" })).toBe(false);
  });

  it.each(["contains", "equals", "regex"] as const)(
    "body + %s without a value is rejected",
    (operator) => {
      expect(accepts({ target: "body", operator })).toBe(false);
    },
  );

  // header: every operator is legal, but a valid `key` is required, and
  // non-exists operators still require a value.
  it.each(["contains", "equals", "regex"] as const)(
    "header + %s with a key and value is valid",
    (operator) => {
      expect(
        accepts({ target: "header", operator, key: "X-Api-Key", value: "x" }),
      ).toBe(true);
    },
  );

  it("header + exists with a key and no value is valid", () => {
    expect(
      accepts({ target: "header", operator: "exists", key: "X-Api-Key" }),
    ).toBe(true);
  });

  it.each(["contains", "equals", "regex"] as const)(
    "header + %s without a value is rejected",
    (operator) => {
      expect(accepts({ target: "header", operator, key: "X-Api-Key" })).toBe(
        false,
      );
    },
  );

  it("header without a key is rejected", () => {
    expect(
      accepts({ target: "header", operator: "contains", value: "x" }),
    ).toBe(false);
    expect(
      issues({ target: "header", operator: "contains", value: "x" }),
    ).toContain("header conditions require a header name (key)");
  });

  it("header with a blank/whitespace-only key is rejected", () => {
    expect(
      accepts({
        target: "header",
        operator: "contains",
        key: "   ",
        value: "x",
      }),
    ).toBe(false);
  });

  it("header with an invalid header name is rejected", () => {
    expect(
      accepts({
        target: "header",
        operator: "contains",
        key: "X Api Key",
        value: "x",
      }),
    ).toBe(false);
    expect(
      issues({
        target: "header",
        operator: "contains",
        key: "X Api Key",
        value: "x",
      }),
    ).toContain("invalid header name");
  });
});

describe("ruleConditionSchema — value-operator requirement", () => {
  it.each(["contains", "equals", "regex"] as const)(
    "%s requires a non-empty value even when the field is present but empty",
    (operator) => {
      expect(accepts({ target: "body", operator, value: "" })).toBe(false);
    },
  );
});

describe("ruleConditionSchema — regex compile check", () => {
  it("accepts a compiling regex", () => {
    expect(
      accepts({ target: "body", operator: "regex", value: "^foo.*bar$" }),
    ).toBe(true);
  });

  it("rejects a regex that fails to compile", () => {
    expect(
      accepts({ target: "body", operator: "regex", value: "(unterminated" }),
    ).toBe(false);
    expect(
      issues({ target: "body", operator: "regex", value: "(unterminated" }),
    ).toContain("invalid regular expression");
  });

  it("normalizes Rust-only syntax before compiling — (?i) inline flag", () => {
    expect(
      accepts({ target: "body", operator: "regex", value: "(?i)foo" }),
    ).toBe(true);
  });

  it("normalizes Rust-only syntax before compiling — scoped flag group", () => {
    expect(
      accepts({ target: "body", operator: "regex", value: "(?i:foo)bar" }),
    ).toBe(true);
  });

  it("normalizes Rust-only syntax before compiling — named group (?P<name>...)", () => {
    expect(
      accepts({ target: "body", operator: "regex", value: "(?P<name>foo)" }),
    ).toBe(true);
  });

  it("does not regex-compile-check non-regex operators", () => {
    // "(unterminated" is not valid JS regex syntax, but as a `contains` value
    // it's just a literal string to search for — must not be rejected.
    expect(
      accepts({ target: "body", operator: "contains", value: "(unterminated" }),
    ).toBe(true);
  });
});

describe("ruleConditionSchema — field limits", () => {
  it("rejects a value over 1000 characters", () => {
    expect(
      accepts({
        target: "body",
        operator: "contains",
        value: "a".repeat(1001),
      }),
    ).toBe(false);
  });

  it("rejects a key over 500 characters", () => {
    expect(
      accepts({
        target: "header",
        operator: "exists",
        key: "a".repeat(501),
      }),
    ).toBe(false);
  });
});
