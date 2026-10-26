import { describe, expect, it } from "vitest"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import {
  parseTaskGraphResultProjection,
  taskGraphResultProjectionBytes,
  taskGraphResultProjectionItems,
} from "./canonical-turn-task-graph-node-projection.js"

const digest = `sha256:${"a".repeat(64)}`

function unavailableProjection() {
  return { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" }
}

describe("TaskGraph node result projections", () => {
  it("preserves valid scout candidate ordering and projection accounting", () => {
    const value = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "scout", status: "completed", candidateCount: 2, evidenceCount: 2,
      candidates: [
        { jobId: "job-2", source: "lever", evidenceKinds: ["job", "resume"] },
        { jobId: "job-1", source: "greenhouse", evidenceKinds: ["persona"] },
      ],
    }
    const parsed = parseTaskGraphResultProjection(value)

    expect(parsed).toEqual(value)
    expect(taskGraphResultProjectionItems(parsed)).toBe(2)
    expect(taskGraphResultProjectionBytes(parsed)).toBe(Buffer.byteLength(JSON.stringify(parsed), "utf8"))
  })

  it("rejects malformed analyst evidence and unexpected projection keys", () => {
    const analyst = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "analyst", status: "partial", findingCount: 1, evidenceCount: 2,
      findings: [{ jobId: "job-1", score: 8.5, evidenceKinds: ["job", "job"] }],
    }
    expect(parseTaskGraphResultProjection(analyst)).toEqual(unavailableProjection())
    expect(parseTaskGraphResultProjection({ ...analyst, findings: [{ jobId: "job-1", score: 8.5, evidenceKinds: ["job"] }], extra: true }))
      .toEqual(unavailableProjection())
    expect(taskGraphResultProjectionItems(parseTaskGraphResultProjection(analyst))).toBe(0)
  })

  it("validates writer and reviewer artifact references", () => {
    const artifactRef = { artifactId: "artifact-1", version: 1, contentHash: digest, sourceDigest: digest }
    const writer = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "writer", status: "completed", artifactRef,
    }
    const reviewer = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash: digest,
    }

    expect(parseTaskGraphResultProjection(writer)).toEqual(writer)
    expect(taskGraphResultProjectionItems(parseTaskGraphResultProjection(writer))).toBe(1)
    expect(parseTaskGraphResultProjection(reviewer)).toEqual(reviewer)
    expect(parseTaskGraphResultProjection({ ...reviewer, reviewHash: "sha256:bad" })).toEqual(unavailableProjection())
  })
})
