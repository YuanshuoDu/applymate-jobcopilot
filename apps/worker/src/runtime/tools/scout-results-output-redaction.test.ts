import { describe, expect, it } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"
import { prepareScoutResultsOutput } from "./scout-results-output-redaction.js"

const NUMERIC_UUID = "00000000-0000-4000-8000-000000000000"
const NUMERIC_CHILD_ID = "subagent-00000000-0000-4000-8000-000000000001"

function result(jobId = NUMERIC_UUID) {
  return { availability: "available", children: [{ taskId: NUMERIC_CHILD_ID, status: "completed",
    candidates: [{ jobId, source: "greenhouse" }] }] }
}

describe("nested Scout results output redaction", () => {
  it("preserves only canonical candidate Job IDs in the verified path", () => {
    expect(redactSensitiveValue(NUMERIC_UUID)).toBe("[REDACTED_PHONE]")
    expect(prepareScoutResultsOutput(result())).toEqual({ availability: "available", children: [{
      taskId: redactSensitiveValue(NUMERIC_CHILD_ID), status: "completed",
      candidates: [{ jobId: NUMERIC_UUID, source: "greenhouse" }],
    }] })
  })

  it("keeps noncanonical phone-like values on ordinary redaction", () => {
    const safe = prepareScoutResultsOutput(result("+353 87 123 4567"))
    expect(safe).toMatchObject({ children: [{ candidates: [{ jobId: "[REDACTED_PHONE]" }] }] })
  })

  it("allows repeated Job IDs across distinct completed Scouts and terminal empty rows", () => {
    expect(prepareScoutResultsOutput({ availability: "available", children: [
      { taskId: "child-a", status: "completed", candidates: [{ jobId: NUMERIC_UUID, source: "greenhouse" }] },
      { taskId: "child-b", status: "completed", candidates: [{ jobId: NUMERIC_UUID, source: "lever" }] },
    ] })).toMatchObject({ children: [
      { candidates: [{ jobId: NUMERIC_UUID }] }, { candidates: [{ jobId: NUMERIC_UUID }] },
    ] })
    expect(prepareScoutResultsOutput({ availability: "available", children: [
      { taskId: "child-failed", status: "failed", candidates: [] },
    ] })).toEqual({ availability: "available", children: [{ taskId: "child-failed", status: "failed", candidates: [] }] })
  })

  it("rejects unrelated, duplicate, nonterminal, and oversized shapes", () => {
    const valid = result()
    expect(prepareScoutResultsOutput({ ...valid, extra: NUMERIC_UUID })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "pending", children: [] })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "available", children: [
      valid.children[0], { ...valid.children[0], candidates: [] },
    ] })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "available", children: [{
      taskId: "child-a", status: "completed", candidates: Array.from({ length: 21 }, () => ({ jobId: NUMERIC_UUID, source: "greenhouse" })),
    }] })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "available", children: [{
      taskId: "child-failed", status: "failed", candidates: [{ jobId: NUMERIC_UUID, source: "greenhouse" }],
    }] })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "available", children: [{
      taskId: "child-completed", status: "completed", candidates: [{ jobId: NUMERIC_UUID, source: "other" }],
    }] })).toBeNull()
    expect(prepareScoutResultsOutput({ availability: "available", children: Array.from({ length: 3 }, (_, index) => ({
      taskId: `child-${index}`, status: "failed", candidates: [],
    })) })).toBeNull()
  })
})
