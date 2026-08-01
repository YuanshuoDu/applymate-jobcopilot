import { describe, expect, it } from "vitest";
import { confirmedAnswerForLabel, isSensitiveQuestion } from "./helpers.js";

describe("sensitive form questions", () => {
  it("requires explicit handling for salary, visa, legal and signature fields", () => {
    for (const label of ["Salary expectation", "Visa sponsorship", "Criminal history", "Electronic signature"]) {
      expect(isSensitiveQuestion(label)).toBe(true);
    }
    expect(isSensitiveQuestion("Portfolio URL")).toBe(false);
  });

  it("uses a sensitive value only when the candidate confirmed the matching label", () => {
    expect(confirmedAnswerForLabel({ "Visa sponsorship": "No" }, "visa sponsorship required")).toBe("No");
    expect(confirmedAnswerForLabel({ salary: "€80,000" }, "visa sponsorship")).toBe("");
  });
});
