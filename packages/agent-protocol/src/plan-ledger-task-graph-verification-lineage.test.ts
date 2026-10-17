import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { projectPlanLedger } from "./plan-ledger.js"
import { validTaskGraphResultEnvelopeKeys } from "./plan-ledger-task-graph-metadata.js"
import { projectTaskGraphVerificationSummary } from "./plan-ledger-task-graph-verification-display.js"

const sessionId = "session-lineage", turnId = "turn-lineage", rootTaskId = "root-lineage"
const evidenceDigest = "a".repeat(64), resultDigest = "b".repeat(64)
const scoutCriteria = [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }]
const analystCriteria = [{ id: "scout-source", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } }]

function node(key: string, taskId: string, role: "scout" | "analyst", criteria: typeof scoutCriteria | typeof analystCriteria, dependsOn: string[] = []) {
  return { key, taskId, templateId: role, goal: `Goal ${key}`, successCriteria: ["Check result"], dependsOn, depth: dependsOn.length + 1,
    verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role, criteria } }
}
function report(criteria: readonly { id: string }[], status: "passed" | "failed" = "passed") {
  const reasonCode = status === "passed" ? "criteria_met" : "criterion_not_met"
  return { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status, reasonCode,
    criteria: criteria.map(item => ({ criterionId: item.id, status, reasonCode })), evidenceDigest, resultDigest }
}
function structuredResult(role: "scout" | "analyst") {
  return { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed", summary: `${role} result`,
    [role === "scout" ? "candidates" : "findings"]: [role === "scout"
      ? { jobId: "job-1", source: "greenhouse", url: "https://jobs.example/1", evidenceIds: ["evidence-1"] }
      : { jobId: "job-1", score: 8, evidenceIds: ["evidence-1"] }],
    evidence: [{ id: "evidence-1", kind: "job", ref: "job-1", source: "greenhouse" }] }
}
function envelope(value: ReturnType<typeof report>, extra: Record<string, unknown> = {}, role: "scout" | "analyst" = "scout") {
  return { finalItemId: null, finalText: "result", status: value.status === "failed" ? "failed" : "completed",
    stepCount: 1, toolCallCount: 1, structuredResult: structuredResult(role), taskGraphVerificationReport: value, ...extra }
}
function row(id: string, role: string, status: string, result: unknown, extra: Record<string, unknown> = {}) {
  return { id, sessionId, turnId, rootTaskId, role, status, attemptCount: 1, failureReason: null, result, ...extra }
}
function summary(nodes: readonly unknown[], rows: readonly unknown[]) {
  const graph = { schemaVersion: "agent-harness.v2.task-graph", nodes }
  const projection = projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph, tasks: rows })
  return projection ? projectTaskGraphVerificationSummary({ sessionId, turnId, rootTaskId, revision: 4, graph, tasks: rows,
    digestCanonicalJson: (canonicalJson) => createHash("sha256").update(canonicalJson).digest("hex") }, projection) : null
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

describe("TaskGraph verification current lineage", () => {
  it("requires a passed Analyst dependency binding to match the current completed Scout attempt and report digests", () => {
    const scout = node("scout", "task-scout", "scout", scoutCriteria)
    const analyst = node("analyst", "task-analyst", "analyst", analystCriteria, ["scout"])
    const scoutReport = report(scoutCriteria)
    const binding = { nodeKey: "scout", taskId: "task-scout", attemptCount: 1, nodeDigest: workerDigest(scout),
      resultDigest: scoutReport.resultDigest, evidenceDigest: scoutReport.evidenceDigest, reportDigest: workerDigest(publicReport(scoutReport)) }
    const analystReport = { ...report(analystCriteria), dependencyBindings: [binding] }
    const rows = [row(rootTaskId, "orchestrator", "running", null), row("task-scout", "scout", "completed", envelope(scoutReport)),
      row("task-analyst", "analyst", "completed", envelope(analystReport, {}, "analyst"))]
    expect(summary([scout, analyst], rows)?.nodes[1]).toMatchObject({ status: "passed" })
    const plan = projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph: { schemaVersion: "agent-harness.v2.task-graph", nodes: [scout, analyst] }, tasks: rows })
    expect(plan && projectTaskGraphVerificationSummary({ sessionId, turnId, rootTaskId, revision: 4,
      graph: { schemaVersion: "agent-harness.v2.task-graph", nodes: [scout, analyst] }, tasks: rows }, plan)?.nodes[1])
      .toEqual({ status: "unavailable" })

    const staleAttempt = [rows[0], row("task-scout", "scout", "completed", envelope(scoutReport), { attemptCount: 2 }), rows[2]]
    expect(summary([scout, analyst], staleAttempt)?.nodes[1]).toEqual({ status: "unavailable" })
    const staleStatus = [rows[0], row("task-scout", "scout", "failed", envelope(scoutReport)), rows[2]]
    expect(summary([scout, analyst], staleStatus)?.nodes[1]).toEqual({ status: "unavailable" })
    const staleResultDigest = { ...analystReport, dependencyBindings: [{ ...binding, resultDigest: "e".repeat(64) }] }
    expect(summary([scout, analyst], [rows[0], rows[1], row("task-analyst", "analyst", "completed", envelope(staleResultDigest, {}, "analyst"))])?.nodes[1])
      .toEqual({ status: "unavailable" })
    const staleEvidenceDigest = { ...analystReport, dependencyBindings: [{ ...binding, evidenceDigest: "f".repeat(64) }] }
    expect(summary([scout, analyst], [rows[0], rows[1], row("task-analyst", "analyst", "completed", envelope(staleEvidenceDigest, {}, "analyst"))])?.nodes[1])
      .toEqual({ status: "unavailable" })

    const changedScout = { ...scout, goal: "Find a different source goal" }
    expect(summary([changedScout, analyst], rows)?.nodes[1]).toEqual({ status: "unavailable" })

    const changedSourceReport = { ...scoutReport, resultDigest: "e".repeat(64) }
    const staleReportBinding = { ...binding, resultDigest: changedSourceReport.resultDigest }
    const staleReportAnalyst = { ...report(analystCriteria), dependencyBindings: [staleReportBinding] }
    const staleReportRows = [rows[0], row("task-scout", "scout", "completed", envelope(changedSourceReport)),
      row("task-analyst", "analyst", "completed", envelope(staleReportAnalyst, {}, "analyst"))]
    expect(summary([scout, analyst], staleReportRows)?.nodes[1]).toEqual({ status: "unavailable" })

    const sourceReportWithUnexpectedBindings = { ...scoutReport, dependencyBindings: [binding] }
    const sourceEnvelopeWithUnexpectedBindings = envelope(sourceReportWithUnexpectedBindings)
    expect(validTaskGraphResultEnvelopeKeys(sourceEnvelopeWithUnexpectedBindings)).toBe(true)
    const extraFieldRows = [rows[0], row("task-scout", "scout", "completed", sourceEnvelopeWithUnexpectedBindings), rows[2]]
    expect(summary([scout, analyst], extraFieldRows)?.nodes[1]).toEqual({ status: "unavailable" })
  })

  it("matches Worker canonical hashing for JSON-looking strings in full typed Scout nodes", () => {
    const scout = { ...node("scout", "task-scout", "scout", scoutCriteria), goal: '{"source":"fixture"}' }
    const analyst = node("analyst", "task-analyst", "analyst", analystCriteria, ["scout"])
    const scoutReport = report(scoutCriteria)
    const binding = { nodeKey: "scout", taskId: "task-scout", attemptCount: 1, nodeDigest: workerDigest(scout),
      resultDigest: scoutReport.resultDigest, evidenceDigest: scoutReport.evidenceDigest, reportDigest: workerDigest(publicReport(scoutReport)) }
    const analystReport = { ...report(analystCriteria), dependencyBindings: [binding] }
    const rows = [row(rootTaskId, "orchestrator", "running", null), row("task-scout", "scout", "completed", envelope(scoutReport)),
      row("task-analyst", "analyst", "completed", envelope(analystReport, {}, "analyst"))]
    expect(summary([scout, analyst], rows)?.nodes[1]).toMatchObject({ status: "passed" })
  })

  it("keeps direct verification visible but fails dependent lineage closed without a server digest", () => {
    const scout = node("scout", "task-scout", "scout", scoutCriteria)
    const analyst = node("analyst", "task-analyst", "analyst", analystCriteria, ["scout"])
    const scoutReport = report(scoutCriteria)
    const binding = { nodeKey: "scout", taskId: "task-scout", attemptCount: 1, nodeDigest: workerDigest(scout),
      resultDigest: scoutReport.resultDigest, evidenceDigest: scoutReport.evidenceDigest, reportDigest: workerDigest(publicReport(scoutReport)) }
    const analystReport = { ...report(analystCriteria), dependencyBindings: [binding] }
    const nodes = [scout, analyst], graph = { schemaVersion: "agent-harness.v2.task-graph", nodes }
    const rows = [row(rootTaskId, "orchestrator", "running", null), row("task-scout", "scout", "completed", envelope(scoutReport)),
      row("task-analyst", "analyst", "completed", envelope(analystReport, {}, "analyst"))]
    const plan = projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph, tasks: rows })
    const value = plan && projectTaskGraphVerificationSummary({ sessionId, turnId, rootTaskId, revision: 4, graph, tasks: rows }, plan)
    expect(value?.nodes[0]).toMatchObject({ status: "passed" })
    expect(value?.nodes[1]).toEqual({ status: "unavailable" })
  })

  it("requires repair receipt, selected criteria, and current failed target to match the persisted relation", () => {
    const target = node("target", "task-target", "scout", scoutCriteria)
    const repair = { ...node("repair", "task-repair", "scout", scoutCriteria), repairOf: {
      graphRootTaskId: rootTaskId, nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"],
    } }
    const targetReport = report(scoutCriteria, "failed")
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", verifierVersion: "agent-harness.v2.task-graph-verifier.v1",
      graphRootTaskId: rootTaskId, targetNodeKey: "target", targetTaskId: "task-target", repairNodeKey: "repair", repairTaskId: "task-repair",
      criterionIds: ["candidate-count"], evidenceDigest }
    const rows = [row(rootTaskId, "orchestrator", "running", null),
      row("task-target", "scout", "failed", envelope(targetReport), { failureReason: "task_graph_verification_failed" }),
      row("task-repair", "scout", "completed", envelope(report(scoutCriteria), { taskGraphRepairReceipt: receipt }))]
    expect(summary([target, repair], rows)?.nodes.map(item => item && "status" in item ? item.status : item)).toEqual(["failed", "passed"])

    const noLongerFailed = [rows[0], row("task-target", "scout", "completed", envelope(report(scoutCriteria))), rows[2]]
    expect(summary([target, repair], noLongerFailed)?.nodes[1]).toEqual({ status: "unavailable" })
    const wrongFailureReason = [rows[0], row("task-target", "scout", "failed", envelope(targetReport), { failureReason: "other_failure" }), rows[2]]
    expect(summary([target, repair], wrongFailureReason)?.nodes[1]).toEqual({ status: "unavailable" })
    const wrongReceiptTarget = { ...receipt, targetTaskId: "other-task" }
    const wrongReceipt = [rows[0], rows[1], row("task-repair", "scout", "completed",
      envelope(report(scoutCriteria), { taskGraphRepairReceipt: wrongReceiptTarget }))]
    expect(summary([target, repair], wrongReceipt)?.nodes[1]).toEqual({ status: "unavailable" })
  })
})
