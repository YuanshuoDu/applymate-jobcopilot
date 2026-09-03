import { describe, expect, it } from "vitest";
import type { FormPatternRow } from "../db/form-patterns.js";
import { selectFillStrategy } from "./selector.js";

const pattern: FormPatternRow = {
  id: "pattern-1", userId: "user-1", atsHost: "jobs.example.com", urlPattern: "/apply",
  fieldMapping: { "#name": "fullName" }, successCount: 4, failureCount: 0,
  lastSuccessAt: new Date().toISOString(),
};

describe("selectFillStrategy", () => {
  it("prefers a known deterministic ATS over a cache hit", () => {
    expect(selectFillStrategy({ atsType: "greenhouse", pattern })).toMatchObject({ kind: "deterministic", atsType: "greenhouse" });
  });

  it("uses a healthy pattern before AI", () => {
    expect(selectFillStrategy({ pattern })).toMatchObject({ kind: "pattern", pattern });
  });

  it("falls back to AI only when no deterministic or healthy pattern exists", () => {
    expect(selectFillStrategy({ pattern: null })).toEqual({ kind: "ai", reason: "unknown_ats" });
    expect(selectFillStrategy({ pattern, aiAvailable: false })).toEqual({ kind: "pattern", pattern });
    expect(selectFillStrategy({ pattern: { ...pattern, failureCount: 3 }, aiAvailable: false })).toEqual({ kind: "budget", reason: "ai_budget_exhausted" });
  });
});
