import { describe, expect, it } from "vitest"

import { projectInteractiveDiscoveryShortlist } from "./interactive-discovery-shortlist"

const completed = {
  schemaVersion: 1,
  status: "completed",
  items: [{ jobId: "job-42", score: 8.5, evidenceIds: ["read:job:job-42"] }],
  failures: [],
}

function rootResult(shortlist: unknown) {
  return { structuredResult: { interactiveDiscoveryShortlist: shortlist, privateToolOutput: "PRIVATE_TOOL_OUTPUT" }, finalText: "PRIVATE_MODEL_TEXT" }
}

describe("interactive discovery shortlist projection", () => {
  it("returns only the validated shortlist fields and safe evidence reference", () => {
    expect(projectInteractiveDiscoveryShortlist(rootResult(completed))).toEqual(completed)
  })

  it("retains durable partial and failed terminal states", () => {
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      ...completed, status: "partial", failures: ["scout_result_partial"],
    }))).toMatchObject({ status: "partial", items: completed.items })
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      schemaVersion: 1, status: "failed", items: [], failures: ["no_common_candidates"],
    }))).toEqual({ schemaVersion: 1, status: "failed", items: [], failures: ["no_common_candidates"] })
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      ...completed, status: "partial", failures: ["discovery_runtime_failed"],
    }))).toMatchObject({ status: "partial", items: completed.items, failures: ["discovery_runtime_failed"] })
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      schemaVersion: 1, status: "failed", items: [], failures: ["discovery_runtime_unavailable"],
    }))).toMatchObject({ status: "failed", items: [], failures: ["discovery_runtime_unavailable"] })
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      schemaVersion: 1, status: "failed", items: [], failures: ["scout_task_failed", "analyst_task_incomplete"],
    }))).toMatchObject({ status: "failed", items: [], failures: ["scout_task_failed", "analyst_task_incomplete"] })
  })

  it("fails closed for unknown result fields, unsafe IDs, unbound evidence, and inconsistent states", () => {
    expect(projectInteractiveDiscoveryShortlist(rootResult({ ...completed, raw: "PRIVATE" }))).toBeNull()
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      ...completed, items: [{ jobId: "job-42", score: 8, evidenceIds: ["https://private.example"] }],
    }))).toBeNull()
    expect(projectInteractiveDiscoveryShortlist(rootResult({
      ...completed, status: "failed", items: completed.items, failures: ["no_common_candidates"],
    }))).toBeNull()
  })
})
