import { describe, expect, it } from "vitest";
import type { FormPatternRow } from "../db/form-patterns.js";
import { shouldUsePattern } from "./confidence.js";

function pattern(counts: Pick<FormPatternRow, "successCount" | "failureCount">): FormPatternRow {
  return {
    id: "pattern-1",
    atsHost: "jobs.example.com",
    urlPattern: "company/",
    fieldMapping: {},
    lastSuccessAt: new Date().toISOString(),
    ...counts,
  };
}

describe("shouldUsePattern", () => {
  it("uses a healthy pattern", () => {
    expect(shouldUsePattern(pattern({ successCount: 10, failureCount: 0 }))).toBe(true);
  });

  it("skips a degraded pattern below confidence threshold", () => {
    expect(shouldUsePattern(pattern({ successCount: 1, failureCount: 2 }))).toBe(false);
  });

  it("skips a pattern after three failures", () => {
    expect(shouldUsePattern(pattern({ successCount: 5, failureCount: 3 }))).toBe(false);
  });

  it("uses a zero-count pattern so new patterns get a chance", () => {
    expect(shouldUsePattern(pattern({ successCount: 0, failureCount: 0 }))).toBe(true);
  });

  it("uses a pattern exactly at the confidence threshold", () => {
    expect(shouldUsePattern(pattern({ successCount: 1, failureCount: 1 }))).toBe(true);
  });
});
