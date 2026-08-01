import { describe, expect, it } from "vitest";
import { isSensitiveQuestion } from "./helpers.js";

describe("sensitive form questions", () => {
  it("requires explicit handling for salary, visa, legal and signature fields", () => {
    for (const label of ["Salary expectation", "Visa sponsorship", "Criminal history", "Electronic signature"]) {
      expect(isSensitiveQuestion(label)).toBe(true);
    }
    expect(isSensitiveQuestion("Portfolio URL")).toBe(false);
  });
});
