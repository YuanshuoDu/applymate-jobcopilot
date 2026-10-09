import { describe, expect, it } from "vitest"
import {
  TASK_GRAPH_VERIFIER_VERSION,
  parseStoredTaskGraphVerificationReport,
  publicTaskGraphVerificationReport,
} from "./task-graph-verification-report.js"
import { parseTaskGraphVerificationReport } from "./task-graph-command-port.js"

const digest = "a".repeat(64)
const base = {
  verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
  status: "passed",
  reasonCode: "criteria_met",
  criteria: [{ criterionId: "in-scout", status: "passed", reasonCode: "criteria_met" }],
  evidenceDigest: digest,
  resultDigest: digest,
} as const
const binding = (nodeKey: string) => ({
  nodeKey, taskId: "task-" + nodeKey, attemptCount: 1,
  nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest,
})

describe("TaskGraph verification report storage contract", () => {
  it("keeps legacy unary reports readable and exposes only the exact six-field view", () => {
    const parsed = parseStoredTaskGraphVerificationReport(base, ["in-scout"])
    expect(parsed).toEqual(base)
    expect(parseTaskGraphVerificationReport(base, ["in-scout"])).toEqual(base)
    expect(Object.keys(publicTaskGraphVerificationReport(parsed!)).sort()).toEqual([
      "criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
    ])
  })

  it("requires passed source bindings to match the exact canonical selector set", () => {
    const stored = { ...base, dependencyBindings: [binding("scout-a"), binding("scout-z")] }
    expect(parseStoredTaskGraphVerificationReport(stored, ["in-scout"], ["scout-z", "scout-a"])).toMatchObject({
      status: "passed", dependencyBindings: [{ nodeKey: "scout-a" }, { nodeKey: "scout-z" }],
    })
    expect(parseStoredTaskGraphVerificationReport(stored, ["in-scout"], ["scout-a"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport(base, ["in-scout"], ["scout-a"])).toBeUndefined()
  })

  it("rejects duplicate, unsorted, malformed, or unverified private bindings", () => {
    const valid = { ...base, dependencyBindings: [binding("scout-a"), binding("scout-z")] }
    expect(parseStoredTaskGraphVerificationReport({ ...base, dependencyBindings: [binding("scout-a"), binding("scout-a")] }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...base, dependencyBindings: [binding("scout-z"), binding("scout-a")] }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...base, dependencyBindings: [{ ...binding("scout-a"), nodeDigest: "A".repeat(64) }] }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...base, dependencyBindings: [{ ...binding("scout-a"), attemptCount: 0 }] }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({
      ...valid, status: "unverified", reasonCode: "canonical_evidence_invalid",
      criteria: [{ criterionId: "in-scout", status: "unverified", reasonCode: "canonical_evidence_invalid" }],
    }, ["in-scout"])).toBeUndefined()
  })

  it("permits an unavailable result without fabricated bindings and keeps private fields out of public reads", () => {
    const unavailable = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
      status: "unverified",
      reasonCode: "canonical_evidence_invalid",
      criteria: [{ criterionId: "in-scout", status: "unverified", reasonCode: "canonical_evidence_invalid" }],
      evidenceDigest: null,
      resultDigest: null,
    }
    const parsed = parseStoredTaskGraphVerificationReport(unavailable, ["in-scout"], ["scout-a"])
    expect(parsed).toEqual(unavailable)
    expect(parseTaskGraphVerificationReport({ ...base, dependencyBindings: [binding("scout-a")] }, ["in-scout"])).toEqual(base)
    expect(parseTaskGraphVerificationReport({ ...base, dependencyBindings: [binding("scout-a")] }, ["in-scout"])).not.toHaveProperty("dependencyBindings")
  })
})
