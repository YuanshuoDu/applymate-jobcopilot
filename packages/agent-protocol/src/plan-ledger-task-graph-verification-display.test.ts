import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { projectPlanLedger, type PlanLedger } from "./plan-ledger.js"
import {
  parseTaskGraphVerificationSummary,
  projectTaskGraphVerificationSummary,
  type TaskGraphVerificationSummary,
} from "./plan-ledger-task-graph-verification-display.js"

const sessionId = "session-1", turnId = "turn-1", rootTaskId = "root-1", digest = "a".repeat(64)
const scoutCriteria = [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
  { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 2 } },
  { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 2 } },
]
const analystCriteria = [
  { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
  { id: "analyst-evidence-count", check: { kind: "evidence_count_gte", minimum: 1 } },
  { id: "finding-evidence", check: { kind: "all_findings_have_evidence", minimumItems: 1 } },
  { id: "score", check: { kind: "reported_score_gte", minimumScore: 7, minimumFindings: 1, aggregation: "any" } },
  { id: "from-scout", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
  { id: "scout-coverage", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout", minimumPercent: 75 } },
]

function typedNode(key: string, taskId: string, role: "scout" | "analyst", criteria: typeof scoutCriteria, dependsOn: string[] = []) {
  return { key, templateId: role, goal: `Private goal ${key}`, successCriteria: [`Private criterion ${key}`], dependsOn, depth: dependsOn.length + 1, taskId,
    verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role, criteria } }
}
function report(criteria: readonly { id: string }[], status: "passed" | "failed" | "unverified" = "passed") {
  const criterionStatus = status === "passed" ? "passed" : status
  const reasonCode = status === "passed" ? "criteria_met" : status === "failed" ? "criterion_not_met" : "canonical_evidence_missing"
  return { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status, reasonCode,
    criteria: criteria.map(item => ({ criterionId: item.id, status: criterionStatus, reasonCode })),
    evidenceDigest: status === "unverified" ? null : digest, resultDigest: status === "unverified" ? null : "b".repeat(64) }
}
function result(taskGraphVerificationReport?: ReturnType<typeof report>, extra: Record<string, unknown> = {}) {
  return { finalItemId: null, finalText: "PRIVATE_RESULT_TEXT", status: taskGraphVerificationReport?.status === "failed" ? "failed" : "completed",
    stepCount: 2, toolCallCount: 1, structuredResult: { private: "PRIVATE_STRUCTURED_RESULT" },
    ...(taskGraphVerificationReport ? { taskGraphVerificationReport } : {}), ...extra }
}
function row(id: string, role: string, status: string, resultValue: unknown = null) {
  return { id, sessionId, turnId, rootTaskId, role, status, attemptCount: 1, failureReason: null, result: resultValue, goal: `Private row goal ${id}` }
}
function graph(nodes: readonly unknown[]) { return { schemaVersion: "agent-harness.v2.task-graph", nodes } }
function projection(nodes: readonly unknown[], rows: readonly unknown[], revision = 3): PlanLedger {
  const snapshot = graph(nodes)
  const plan = projectPlanLedger({ sessionId, revision, rootTaskId, graph: snapshot, tasks: rows })
  if (!plan) throw new Error("fixture_plan_projection_invalid")
  return plan
}
function summary(nodes: readonly unknown[], rows: readonly unknown[], revision = 3, selected = projection(nodes, rows, revision)) {
  return projectTaskGraphVerificationSummary({ sessionId, turnId, rootTaskId, revision, graph: graph(nodes), tasks: rows,
    digestCanonicalJson: (canonicalJson) => createHash("sha256").update(canonicalJson).digest("hex") }, selected)
}
function workerDigest(value: unknown): string { return createHash("sha256").update(workerCanonicalJson(value)).digest("hex") }
function workerCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(workerCanonicalJson).join(",") + "]"
  const object = workerObject(value)
  if (object) return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + workerCanonicalJson(object[key])).join(",") + "}"
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("test_json_invalid")
  return encoded
}
function workerObject(value: unknown): Record<string, unknown> | null {
  let parsed = value
  if (typeof value === "string") { try { parsed = JSON.parse(value) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0
    ? parsed as Record<string, unknown> : null
}
function publicReport(value: ReturnType<typeof report>) {
  return { verifierVersion: value.verifierVersion, status: value.status, reasonCode: value.reasonCode, criteria: value.criteria,
    evidenceDigest: value.evidenceDigest, resultDigest: value.resultDigest }
}
function passedResult(criteria: readonly { id: string }[], extra: Record<string, unknown> = {}) { return result(report(criteria), extra) }
function scoutResult() {
  const candidates = Array.from({ length: 4 }, (_, index) => ({ jobId: `job-${index + 1}`, source: "greenhouse",
    url: `https://jobs.example/${index + 1}`, evidenceIds: [`evidence-${index + 1}`] }))
  return { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", summary: "Scout result",
    candidates, evidence: candidates.map(candidate => ({ id: candidate.evidenceIds[0], kind: "job", ref: candidate.jobId, source: candidate.source })) }
}

describe("TaskGraph verification display projection", () => {
  it("projects the closed check kinds in snapshot order and omits private identities and evidence", () => {
    const scout = typedNode("scout", "task-scout", "scout", scoutCriteria)
    const analyst = typedNode("analyst", "task-analyst", "analyst", analystCriteria, ["scout"])
    const scoutReport = report(scoutCriteria)
    const bindings = [{ nodeKey: "scout", taskId: "task-scout", attemptCount: 1, nodeDigest: workerDigest(scout),
      resultDigest: scoutReport.resultDigest, evidenceDigest: scoutReport.evidenceDigest, reportDigest: workerDigest(publicReport(scoutReport)) }]
    const rows = [row(rootTaskId, "orchestrator", "running"), row("task-scout", "scout", "completed", passedResult(scoutCriteria, { structuredResult: scoutResult() })),
      row("task-analyst", "analyst", "completed", passedResult(analystCriteria, { taskGraphVerificationReport: { ...report(analystCriteria), dependencyBindings: bindings } }))]
    const value = summary([scout, analyst], rows)
    expect(value?.nodes.map(node => node && "status" in node ? node.status : node)).toEqual(["passed", "passed"])
    expect(value?.nodes[0]).toMatchObject({ totalCount: 3, passedCount: 3, failedCount: 0, unverifiedCount: 0 })
    expect(value?.nodes[1]).toMatchObject({ totalCount: 6, passedCount: 6 })
    expect(value?.nodes.flatMap(node => node && "checks" in node ? node.checks : []).map(check => check.kind)).toEqual([
      "candidate_count_gte", "evidence_count_gte", "all_candidates_have_evidence", "finding_count_gte", "evidence_count_gte",
      "all_findings_have_evidence", "reported_score_gte", "findings_from_scout_dependency", "findings_cover_scout_candidates_gte",
    ])
    const serialized = JSON.stringify(value)
    for (const privateValue of ["task-scout", "root-1", '"nodeKey":"scout"', "PRIVATE_RESULT_TEXT", "PRIVATE_STRUCTURED_RESULT", digest,
      bindings[0]!.nodeDigest, bindings[0]!.reportDigest,
      "criteria_met", "dependencyBindings", "dependencyNodeKey", "Private goal"]) expect(serialized).not.toContain(privateValue)
    expect(value?.nodes[1] && "checks" in value.nodes[1] ? value.nodes[1].checks.at(-1) : null).toEqual({
      kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "passed" })
  })

  it("keeps declared coverage failure visible beside a current receipt-backed repair", () => {
    const coverageCriteria = [{ id: "scout-coverage", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout", minimumPercent: 75 } }]
    const scout = typedNode("scout", "task-scout", "scout", scoutCriteria)
    const target = typedNode("target", "task-target", "analyst", coverageCriteria, ["scout"])
    const repair = { ...typedNode("repair", "task-repair", "analyst", coverageCriteria, ["scout"]),
      repairOf: { graphRootTaskId: rootTaskId, nodeKey: "target", taskId: "task-target", criterionIds: ["scout-coverage"] } }
    const scoutReport = report(scoutCriteria)
    const bindings = [{ nodeKey: "scout", taskId: "task-scout", attemptCount: 1, nodeDigest: workerDigest(scout),
      resultDigest: scoutReport.resultDigest, evidenceDigest: scoutReport.evidenceDigest, reportDigest: workerDigest(publicReport(scoutReport)) }]
    const scoutRow = row("task-scout", "scout", "completed", passedResult(scoutCriteria, { structuredResult: scoutResult() }))
    const failedReport = { ...report(coverageCriteria, "failed"), dependencyBindings: bindings }
    const targetRow = { ...row("task-target", "analyst", "failed", result(failedReport)), failureReason: "task_graph_verification_failed" }
    const repairedReport = { ...report(coverageCriteria), dependencyBindings: bindings }
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: rootTaskId,
      targetNodeKey: "target", targetTaskId: "task-target", criterionIds: ["scout-coverage"], repairNodeKey: "repair",
      repairTaskId: "task-repair", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: repairedReport.evidenceDigest }
    const repairRow = row("task-repair", "analyst", "completed", passedResult(coverageCriteria, {
      taskGraphVerificationReport: repairedReport, taskGraphRepairReceipt: receipt,
    }))
    const nodes = [scout, target, repair], rows = [row(rootTaskId, "orchestrator", "running"), scoutRow, targetRow, repairRow]
    const value = summary(nodes, rows)
    expect(value?.nodes.map(node => node && "status" in node ? node.status : node)).toEqual(["passed", "failed", "passed"])
    expect(value?.nodes[1] && "checks" in value.nodes[1] ? value.nodes[1].checks : []).toEqual([
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "failed" },
    ])
    expect(value?.nodes[2] && "checks" in value.nodes[2] ? value.nodes[2].checks : []).toEqual([
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "passed" },
    ])
    const changedRepair = { ...repair, verification: { ...repair.verification, criteria: coverageCriteria.map(item => ({ ...item,
      check: { ...item.check, minimumPercent: 50 } })) } }
    expect(summary([scout, target, changedRepair], rows)?.nodes[2]).toEqual({ status: "unavailable" })
    const serialized = JSON.stringify(value)
    for (const privateValue of ["task-scout", "task-target", "task-repair", "root-1", "dependencyBindings", "dependencyNodeKey",
      "scout-coverage", "job-1", digest, "PRIVATE_RESULT_TEXT", "PRIVATE_STRUCTURED_RESULT"]) expect(serialized).not.toContain(privateValue)

    const withoutBinding = row("task-target", "analyst", "failed", result(report(coverageCriteria, "failed")))
    expect(summary(nodes, [rows[0], scoutRow, { ...withoutBinding, failureReason: "task_graph_verification_failed" }, repairRow])?.nodes[1])
      .toEqual({ status: "unavailable" })
    expect(summary(nodes, [rows[0], scoutRow, targetRow, { ...repairRow,
      result: passedResult(coverageCriteria, { taskGraphRepairReceipt: receipt }) }])?.nodes[2]).toEqual({ status: "unavailable" })
    const staleBinding = [{ ...bindings[0]!, nodeDigest: "c".repeat(64) }]
    const staleReport = { ...failedReport, dependencyBindings: staleBinding }
    expect(summary(nodes, [rows[0], scoutRow, { ...targetRow, result: result(staleReport) }, repairRow])?.nodes[1])
      .toEqual({ status: "unavailable" })
    const swappedBinding = [{ ...bindings[0]!, nodeKey: "other-scout" }]
    expect(summary(nodes, [rows[0], scoutRow, { ...targetRow, result: result({ ...failedReport, dependencyBindings: swappedBinding }) }, repairRow])?.nodes[1])
      .toEqual({ status: "unavailable" })
    expect(summary(nodes, [rows[0], scoutRow, { ...targetRow, role: "scout" }, repairRow])?.nodes[1]).toEqual({ status: "unavailable" })
  })

  it("admits only the exact Analyst coverage check with a bounded integer threshold", () => {
    const planFor = (role: "scout" | "analyst", check: Record<string, unknown>) => projectPlanLedger({ sessionId, revision: 3, rootTaskId,
      graph: graph([typedNode("coverage", "task-coverage", role, [{ id: "coverage", check }])]), tasks: [] })
    const check = { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout", minimumPercent: 75 }
    expect(planFor("analyst", check)).not.toBeNull()
    expect(planFor("analyst", { ...check, minimumPercent: 1 })).not.toBeNull()
    expect(planFor("analyst", { ...check, minimumPercent: 100 })).not.toBeNull()
    for (const minimumPercent of [0, 101, 75.5, "75"]) expect(planFor("analyst", { ...check, minimumPercent })).toBeNull()
    expect(planFor("analyst", { ...check, privateId: "secret" })).toBeNull()
    expect(planFor("scout", check)).toBeNull()
  })

  it("keeps untyped nodes null and never infers a pass from completed status or missing reports", () => {
    const scout = typedNode("scout", "task-scout", "scout", [scoutCriteria[0]])
    const legacy = { key: "legacy", templateId: "writer", goal: "Legacy", successCriteria: ["Write"], dependsOn: [], depth: 1, taskId: "task-legacy", verificationDisposition: "legacy_unverified" }
    const rows = [row(rootTaskId, "orchestrator", "running"), row("task-scout", "scout", "completed", result()), row("task-legacy", "writer", "completed", result())]
    expect(summary([legacy, scout], rows)?.nodes).toEqual([null, { status: "unavailable" }])
    const noTyped = { ...legacy, key: "other", taskId: "task-other" }
    expect(summary([legacy, noTyped], [...rows, row("task-other", "writer", "completed", result())])).toBeNull()
  })

  it("requires ordered criteria and coherent persisted task/report status", () => {
    const scout = typedNode("scout", "task-scout", "scout", scoutCriteria.slice(0, 2))
    const rows = [row(rootTaskId, "orchestrator", "running"), row("task-scout", "scout", "completed", passedResult(scoutCriteria.slice(0, 2)))]
    const wrongOrder = result({ ...report(scoutCriteria.slice(0, 2)), criteria: [...report(scoutCriteria.slice(0, 2)).criteria].reverse() })
    expect(summary([scout], [rows[0], row("task-scout", "scout", "completed", wrongOrder)])?.nodes).toEqual([{ status: "unavailable" }])
    const wrongStatusReport = report(scoutCriteria.slice(0, 2), "failed")
    expect(summary([scout], [rows[0], row("task-scout", "scout", "completed", result(wrongStatusReport))])?.nodes).toEqual([{ status: "unavailable" }])
    const invalidEnvelope = { ...passedResult(scoutCriteria.slice(0, 2)), taskGraphVerificationReport: { ...report(scoutCriteria.slice(0, 2)), schemaVersion: "wrong" } }
    expect(summary([scout], [rows[0], row("task-scout", "scout", "completed", invalidEnvelope)])?.nodes).toEqual([{ status: "unavailable" }])
  })

  it("keeps a failed target failed beside a passing repair and rejects foreign repair lineage", () => {
    const targetCriteria = [scoutCriteria[0]]
    const target = typedNode("target", "task-target", "scout", targetCriteria)
    const repair = { ...typedNode("repair", "task-repair", "scout", targetCriteria), repairOf: { graphRootTaskId: rootTaskId, nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] } }
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: rootTaskId, targetNodeKey: "target", targetTaskId: "task-target",
      criterionIds: ["candidate-count"], repairNodeKey: "repair", repairTaskId: "task-repair", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: digest }
    const rows = [row(rootTaskId, "orchestrator", "running"), { ...row("task-target", "scout", "failed", result(report(targetCriteria, "failed"))), failureReason: "task_graph_verification_failed" },
      row("task-repair", "scout", "completed", passedResult(targetCriteria, { taskGraphRepairReceipt: receipt }))]
    expect(summary([target, repair], rows)?.nodes.map(node => node && "status" in node ? node.status : node)).toEqual(["failed", "passed"])
    const foreignRepair = { ...repair, repairOf: { ...repair.repairOf, graphRootTaskId: "other-root" } }
    expect(summary([target, foreignRepair], rows)?.nodes[1]).toEqual({ status: "unavailable" })
  })

  it("rejects malformed or internally inconsistent untrusted sidecars", () => {
    const valid: TaskGraphVerificationSummary = { schemaVersion: 1, nodes: [{ status: "failed", checks: [
      { kind: "candidate_count_gte", minimum: 2, status: "failed" },
    ], totalCount: 1, passedCount: 0, failedCount: 1, unverifiedCount: 0 }] }
    expect(parseTaskGraphVerificationSummary(valid, 1)).toEqual(valid)
    const coverage = { schemaVersion: 1, nodes: [{ status: "failed", checks: [
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "failed" },
    ], totalCount: 1, passedCount: 0, failedCount: 1, unverifiedCount: 0 }] }
    expect(parseTaskGraphVerificationSummary(coverage, 1)?.nodes[0]).toEqual(coverage.nodes[0])
    for (const descriptor of [
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 0, status: "failed" },
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "failed", dependencyNodeKey: "scout" },
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "failed", numerator: 3, denominator: 4 },
      { kind: "findings_cover_scout_candidates_gte", minimumPercent: 75, status: "failed", privateNote: "raw report" },
    ]) expect(parseTaskGraphVerificationSummary({ ...coverage, nodes: [{ ...coverage.nodes[0], checks: [descriptor] }] }, 1)).toBeNull()
    expect(parseTaskGraphVerificationSummary({ ...valid, nodes: [{ ...valid.nodes[0], passedCount: 1 }] }, 1)).toBeNull()
    expect(parseTaskGraphVerificationSummary({ ...valid, nodes: [{ ...valid.nodes[0], status: "passed" }] }, 1)).toBeNull()
    expect(parseTaskGraphVerificationSummary({ ...valid, private: "raw result" }, 1)).toBeNull()
    expect(parseTaskGraphVerificationSummary({ schemaVersion: 1, nodes: [{ status: "unverified", checks: [
      { kind: "finding_count_gte", minimum: 1, status: "passed" }, { kind: "finding_count_gte", minimum: 2, status: "failed" },
    ], totalCount: 2, passedCount: 1, failedCount: 1, unverifiedCount: 0 }] }, 1)).toBeNull()
  })
})
