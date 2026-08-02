import { describe, expect, it } from "vitest";
import { formNeedsMessage } from "./form-review.js";

describe("form review needs", () => {
  it("keeps required and sensitive fields as separate user-review reasons", () => {
    expect(formNeedsMessage({ missing: ["Portfolio"], sensitive: ["Visa sponsorship", "Salary expectation"] }))
      .toBe("Missing required fields: Portfolio. Sensitive fields require your confirmation: Visa sponsorship, Salary expectation");
  });

  it("returns null when the filled form has no programmatic review blockers", () => {
    expect(formNeedsMessage({ missing: [], sensitive: [] })).toBeNull();
  });
});
