import { describe, expect, it } from "vitest"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA as reexported, type TaskGraphResultProjection } from "./task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-result-projection-contract.js"
import { projectTaskGraphResult } from "./task-graph-result-projection.js"

describe("TaskGraph projection contract extraction", () => {
  it("preserves the projection schema identity re-exported by the command port", () => {
    expect(TASK_GRAPH_RESULT_PROJECTION_SCHEMA).toBe("agent-harness.v2.task-graph.result-projection")
    expect(reexported).toBe(TASK_GRAPH_RESULT_PROJECTION_SCHEMA)
  })

  it("keeps the existing projection implementation assignable through its old command-port type", () => {
    const projection: TaskGraphResultProjection = projectTaskGraphResult("scout", "completed", {
      status: "completed", finalItemId: null, finalText: "final", stepCount: 1, toolCallCount: 1,
      structuredResult: {
        schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "partial",
        candidates: [{ jobId: "job-a", source: "greenhouse", url: "https://private.example/job-a", evidenceIds: ["evidence-a"] }],
        evidence: [{ id: "evidence-a", kind: "job", ref: "job-a", source: "private-source" }], summary: "private summary",
      },
    })
    expect(projection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "scout", status: "partial", candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "job-a", source: "greenhouse", evidenceKinds: ["job"] }],
    })
  })
})
