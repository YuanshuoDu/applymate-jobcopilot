import { describe, expect, it } from "vitest"
import {
  TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION,
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

  it("stores failed multi-source bindings privately while retaining v1 read behavior", () => {
    expect(TASK_GRAPH_VERIFIER_VERSION).toBe("agent-harness.v2.task-graph-verifier.v1")
    const failed = {
      ...base,
      status: "failed",
      reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "in-scout", status: "failed", reasonCode: "criterion_not_met" }],
      dependencyBindings: [binding("scout-a"), binding("scout-b")],
    }
    const parsed = parseStoredTaskGraphVerificationReport(failed, ["in-scout"], ["scout-b", "scout-a"])
    expect(parsed).toMatchObject({ status: "failed", dependencyBindings: [{ nodeKey: "scout-a" }, { nodeKey: "scout-b" }] })
    const publicReport = publicTaskGraphVerificationReport(parsed!)
    expect(JSON.stringify(publicReport)).not.toContain("scout-a")
    expect(JSON.stringify(publicReport)).not.toContain("task-scout")
    expect(parseTaskGraphVerificationReport(failed, ["in-scout"])).toEqual(publicReport)

    const oldUnverified = {
      ...base,
      status: "unverified",
      reasonCode: "canonical_evidence_missing",
      criteria: [{ criterionId: "in-scout", status: "unverified", reasonCode: "canonical_evidence_missing" }],
      evidenceDigest: null,
      resultDigest: null,
    }
    expect(parseStoredTaskGraphVerificationReport(oldUnverified, ["in-scout"], ["scout-a"])).toMatchObject({
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "unverified", reasonCode: "canonical_evidence_missing",
    })
    expect(parseTaskGraphVerificationReport(oldUnverified, ["in-scout"])).toMatchObject({
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "unverified", reasonCode: "canonical_evidence_missing",
    })
    const failedV2 = { ...failed, verifierVersion: TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION }
    const parsedV2 = parseStoredTaskGraphVerificationReport(failedV2, ["in-scout"], ["scout-b", "scout-a"])
    expect(parsedV2).toMatchObject({ verifierVersion: TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION, status: "failed" })
    const publicV2 = publicTaskGraphVerificationReport(parsedV2!)
    expect(publicV2.verifierVersion).toBe(TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION)
    expect(JSON.stringify(publicV2)).not.toContain("scout-a")
    expect(parseTaskGraphVerificationReport(failedV2, ["in-scout"])).toEqual(publicV2)

    // A #1068 reader only accepted its exact v1 identifier; it must reject the new semantic version.
    const oldReader = (value: unknown) => {
      if (!value || typeof value !== "object" || (value as { verifierVersion?: unknown }).verifierVersion !== TASK_GRAPH_VERIFIER_VERSION) return undefined
      return parseStoredTaskGraphVerificationReport(value, ["in-scout"])
    }
    expect(oldReader(failedV2)).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...oldUnverified, verifierVersion: TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION }, ["in-scout"], ["scout-a", "scout-b"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...failedV2, dependencyBindings: undefined }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...failedV2, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "in-scout", status: "passed", reasonCode: "criteria_met" }] }, ["in-scout"])).toBeUndefined()
    expect(parseStoredTaskGraphVerificationReport({ ...failedV2, dependencyBindings: [binding("scout-a")] }, ["in-scout"])).toBeUndefined()
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
