import { describe, expect, it } from "vitest"
import { isCanonicalAnalyzeSourceFenceTimestamp, scheduledAnalyzeSourceFingerprintRows } from "./turn-question-scheduled-source-fingerprint.js"

const version = "agent-harness.v2.analyze-source-input.v1"
const fingerprint = (char: string) => ({ version, digest: char.repeat(64) })

describe("scheduled Analyze source fingerprints", () => {
  it("projects complete fingerprints in canonical job-ID order", () => {
    expect(scheduledAnalyzeSourceFingerprintRows(["job-z", "job-a"], {
      "job-z": fingerprint("b"), "job-a": fingerprint("a"),
    })).toEqual([["job-a", version, "a".repeat(64)], ["job-z", version, "b".repeat(64)]])
  })

  it.each([
    ["missing map", ["job-a"], undefined],
    ["missing job", ["job-a", "job-b"], { "job-a": fingerprint("a") }],
    ["extra job", ["job-a"], { "job-a": fingerprint("a"), "job-b": fingerprint("b") }],
    ["wrong version", ["job-a"], { "job-a": { ...fingerprint("a"), version: "legacy" } }],
    ["invalid digest", ["job-a"], { "job-a": { ...fingerprint("a"), digest: "A".repeat(64) } }],
    ["extra fingerprint field", ["job-a"], { "job-a": { ...fingerprint("a"), extra: true } }],
    ["symbol fingerprint field", ["job-a"], { "job-a": Object.assign(fingerprint("a"), { [Symbol("extra")]: true }) }],
    ["duplicate job IDs", ["job-a", "job-a"], { "job-a": fingerprint("a") }],
  ] as const)("rejects %s", (_name, ids, map) => {
    expect(scheduledAnalyzeSourceFingerprintRows(ids, map)).toBeNull()
  })

  it("accepts only absent or empty provenance when there are no scored jobs", () => {
    expect(scheduledAnalyzeSourceFingerprintRows([], undefined)).toEqual([])
    expect(scheduledAnalyzeSourceFingerprintRows([], {})).toEqual([])
    expect(scheduledAnalyzeSourceFingerprintRows([], { "job-a": fingerprint("a") })).toBeNull()
  })

  it("requires an exact canonical ISO timestamp for analysis fences", () => {
    expect(isCanonicalAnalyzeSourceFenceTimestamp("2026-10-19T12:00:00.123Z")).toBe(true)
    expect(isCanonicalAnalyzeSourceFenceTimestamp("2026-10-19T12:00:00+00:00")).toBe(false)
    expect(isCanonicalAnalyzeSourceFenceTimestamp("not-a-date")).toBe(false)
  })
})
