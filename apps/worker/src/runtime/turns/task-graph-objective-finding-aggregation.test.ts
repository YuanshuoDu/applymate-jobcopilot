import { describe, expect, it, vi } from "vitest"
import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import { selectTaskGraphObjectiveRequirementLineages } from "../planning/task-graph-objective-lineage.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA, type AnalystResult } from "../subagents/role-results.js"
import type { GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { gateReport, type GateReport } from "./task-graph-terminal-assessment.js"
import { aggregateTaskGraphObjectiveFindings, verifyTaskGraphObjectiveFindingAggregation } from "./task-graph-objective-finding-aggregation.js"

const ROOT = "root-1"
const requirement: RootTaskVerificationRequirement = { id: "finding-count", kind: "finding_count_gte", minimum: 2 }
const digest = (value: string) => value.repeat(64)

function analystNode(key: string, taskId: string, minimum = 1, repairOf?: StoredTaskGraphNode["repairOf"]): StoredTaskGraphNode {
  return {
    key, taskId, templateId: "analyst", goal: "Analyze verified jobs", successCriteria: ["Return findings"],
    dependsOn: [], depth: 2, verificationDisposition: "typed", ...(repairOf ? { repairOf } : {}),
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: requirement.id, check: { kind: "finding_count_gte", minimum } }] },
  }
}

function structuredResult(jobIds: readonly string[]): AnalystResult {
  const evidence = jobIds.map(jobId => ({ id: `read:job:${jobId}`, kind: "job" as const, ref: jobId, source: "fixture" }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", summary: "Verified findings",
    findings: jobIds.map(jobId => ({ jobId, score: 8, evidenceIds: [`read:job:${jobId}`] })), evidence,
  }
}

function task(node: StoredTaskGraphNode, jobIds: readonly string[], options: {
  status?: GraphTaskRow["status"]; failureReason?: string | null; receipt?: unknown; reportStatus?: "passed" | "failed"
} = {}): GraphTaskRow {
  const structured = structuredResult(jobIds)
  const reportStatus = options.reportStatus ?? "passed"
  const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: reportStatus,
    reasonCode: reportStatus === "passed" ? "criteria_met" : "criterion_not_met",
    criteria: [{ criterionId: requirement.id, status: reportStatus, reasonCode: reportStatus === "passed" ? "criteria_met" : "criterion_not_met" }],
    evidenceDigest: digest("a"), resultDigest: taskGraphResultDigest(structured) }
  return { id: node.taskId, role: "analyst", status: options.status ?? "completed",
    failureReason: options.failureReason ?? null,
    result: { structuredResult: structured, taskGraphVerificationReport: report,
      ...(options.receipt === undefined ? {} : { taskGraphRepairReceipt: options.receipt }) } }
}

function reports(nodes: readonly StoredTaskGraphNode[], tasks: ReadonlyMap<string, GraphTaskRow>) {
  const result = new Map<string, GateReport>()
  for (const node of nodes) {
    const taskRow = tasks.get(node.taskId)
    const parsed = taskRow && gateReport(node, taskRow.result, taskRow.role)
    if (parsed) result.set(node.taskId, parsed)
  }
  return result
}

function evaluate(nodes: readonly StoredTaskGraphNode[], applicable: readonly StoredTaskGraphNode[], rows: readonly GraphTaskRow[]) {
  const tasks = new Map(rows.map(row => [row.id, row]))
  return aggregateTaskGraphObjectiveFindings({ requirement,
    full: selectTaskGraphObjectiveRequirementLineages(requirement, nodes, ROOT),
    applicableTaskIds: new Set(applicable.map(node => node.taskId)),
    fullNodes: nodes, tasks, reports: reports(nodes, tasks), rootTaskId: ROOT })
}

describe("TaskGraph objective finding aggregation", () => {
  it("denies overlapping Analyst results and accepts distinct verified Job IDs", () => {
    const first = analystNode("analyst-a", "task-a"), second = analystNode("analyst-b", "task-b")
    expect(evaluate([first, second], [first, second], [task(first, ["job-1"]), task(second, ["job-1"])])).toEqual({
      status: "shortfall", criterionId: requirement.id, required: 2, observed: 1,
    })
    expect(evaluate([first, second], [first, second], [task(first, ["job-1"]), task(second, ["job-2"])])).toEqual({
      status: "satisfied", criterionId: requirement.id, required: 2, observed: 2,
    })
  })

  it("does not let a distinct finding on a historical Analyst satisfy current coverage", () => {
    const current = analystNode("analyst-current", "task-current"), historical = analystNode("analyst-historical", "task-historical")
    expect(evaluate([current, historical], [current], [task(current, ["job-current"]), task(historical, ["job-historical"])])).toEqual({
      status: "shortfall", criterionId: requirement.id, required: 2, observed: 1,
    })
    expect(evaluate([current, historical], [], [task(current, ["job-current"]), task(historical, ["job-historical"])])).toEqual({
      status: "shortfall", criterionId: requirement.id, required: 2, observed: 0,
    })
  })

  it("does not aggregate a single effective lineage and rejects a changed persisted result digest", () => {
    const single = analystNode("analyst-a", "task-a")
    expect(evaluate([single], [single], [task(single, ["job-1"])])).toEqual({ status: "not_applicable" })
    const first = analystNode("analyst-a", "task-a"), second = analystNode("analyst-b", "task-b")
    const rows = [task(first, ["job-1"]), task(second, ["job-2"])], checkedReports = reports([first, second], new Map(rows.map(row => [row.id, row])))
    checkedReports.set(second.taskId, { ...checkedReports.get(second.taskId)!, resultDigest: digest("f") })
    expect(aggregateTaskGraphObjectiveFindings({ requirement,
      full: selectTaskGraphObjectiveRequirementLineages(requirement, [first, second], ROOT),
      applicableTaskIds: new Set([first.taskId, second.taskId]),
      fullNodes: [first, second], tasks: new Map(rows.map(row => [row.id, row])), reports: checkedReports, rootTaskId: ROOT,
    })).toEqual({ status: "invalid" })
  })

  it("counts a selected repair only with its exact persisted receipt", () => {
    const target = analystNode("target", "task-target", 1)
    const relation = { graphRootTaskId: ROOT, nodeKey: target.key, taskId: target.taskId, criterionIds: [requirement.id] }
    const repair = analystNode("repair", "task-repair", 1, relation), other = analystNode("other", "task-other", 1)
    const repairResult = task(repair, ["job-1"])
    const parsed = gateReport(repair, repairResult.result, "analyst")
    if (!parsed?.digest) throw new Error("repair_fixture_report_missing")
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: ROOT,
      targetNodeKey: target.key, targetTaskId: target.taskId, repairNodeKey: repair.key, repairTaskId: repair.taskId,
      criterionIds: [requirement.id], verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: parsed.digest }
    const targetTask = task(target, [], { status: "failed", failureReason: "task_graph_verification_failed", reportStatus: "failed" })
    const validRows = [targetTask, { ...repairResult, result: { ...repairResult.result as Record<string, unknown>, taskGraphRepairReceipt: receipt } }, task(other, ["job-2"])]
    expect(evaluate([target, repair, other], [target, repair, other], validRows)).toEqual({
      status: "satisfied", criterionId: requirement.id, required: 2, observed: 2,
    })
    expect(evaluate([target, repair, other], [target, repair, other], [targetTask, repairResult, task(other, ["job-2"])])).toEqual({ status: "invalid" })
  })

  it("reads only the exact leased user Turn after a split candidate and keeps old paths query-free", async () => {
    const first = analystNode("analyst-a", "task-a"), second = analystNode("analyst-b", "task-b")
    const rows = [task(first, ["job-1"]), task(second, ["job-1"])], tasks = new Map(rows.map(row => [row.id, row]))
    const persistedInput = { verificationRequirements: { schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: requirement.id, check: { kind: requirement.kind, minimum: requirement.minimum } }] } }
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ input: persistedInput }], rowCount: 1 }))
    const result = await verifyTaskGraphObjectiveFindingAggregation({ client: { query } as never, lease: {
      turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
      leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
    }, rootTaskId: ROOT, fullNodes: [first, second], applicableTaskIds: new Set([first.taskId, second.taskId]),
    tasks, reports: reports([first, second], tasks), discoveryTurnEligibility: "ordinary" })
    expect(result).toEqual({ status: "shortfall", criterionId: requirement.id, required: 2, observed: 1 })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('turn."source" = \'user\'')
    expect(query.mock.calls[0]?.[0]).toContain('turn."executionMode" = \'canonical_task_graph\'')
    expect(query.mock.calls[0]?.[0]).toContain('turn."leaseVersion" = $6')
    expect(query.mock.calls[0]?.[1]).toEqual(["turn-1", "session-1", "user-1", ROOT, "worker-1", 3])

    query.mockClear()
    await verifyTaskGraphObjectiveFindingAggregation({ client: { query } as never, lease: {
      turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
      leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
    }, rootTaskId: ROOT, fullNodes: [first], applicableTaskIds: new Set([first.taskId]), tasks,
    reports: reports([first], tasks), discoveryTurnEligibility: "ordinary" })
    expect(query).not.toHaveBeenCalled()
    await verifyTaskGraphObjectiveFindingAggregation({ client: { query } as never, lease: {
      turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
      leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
    }, rootTaskId: ROOT, fullNodes: [first, second], applicableTaskIds: new Set([first.taskId, second.taskId]), tasks,
    reports: reports([first, second], tasks), discoveryTurnEligibility: "scheduled" })
    expect(query).not.toHaveBeenCalled()
  })
})
