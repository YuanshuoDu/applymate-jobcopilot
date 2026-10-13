import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, type StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import type { GraphTaskRow, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import {
  buildTaskGraphDenialCheckpoint,
  parseTaskGraphDenialCheckpoint,
  taskGraphTerminalVerificationDigest,
} from "./task-graph-terminal-assessment.js"

const rootTaskId = "root-1"
const evidenceDigest = "a".repeat(64)
const criteria = [
  { id: "criterion-a", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
  { id: "criterion-b", check: { kind: "candidate_count_gte" as const, minimum: 2 } },
]

function result(summary: string, passed: boolean) {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout",
    status: "completed",
    candidates: passed ? [{ jobId: "job-1", source: "fixture", url: null, evidenceIds: ["read:job:job-1"] }] : [],
    evidence: passed ? [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "fixture" }] : [],
    summary,
  }
}

function report(status: "failed" | "unverified" | "passed", value?: ReturnType<typeof result>) {
  const reasonCode = status === "failed" ? "criterion_not_met"
    : status === "unverified" ? "canonical_evidence_missing" : "criteria_met"
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status,
    reasonCode,
    criteria: criteria.map(item => ({
      criterionId: item.id,
      status: status === "passed" ? "passed" : status,
      reasonCode: status === "passed" ? "criteria_met" : reasonCode,
    })),
    evidenceDigest: status === "unverified" ? null : evidenceDigest,
    resultDigest: value ? taskGraphResultDigest(value) : null,
  }
}

function typedNode(input: Readonly<{
  key: string
  taskId: string
  goal?: string
  dependsOn?: readonly string[]
  repairOf?: StoredTaskGraphNode["repairOf"]
  registeredScoutEnvelope?: StoredTaskGraphNode["registeredScoutEnvelope"]
}>): StoredTaskGraphNode {
  return {
    key: input.key,
    taskId: input.taskId,
    templateId: "scout",
    goal: input.goal ?? "Find current evidence",
    successCriteria: ["Find a current candidate"],
    dependsOn: input.dependsOn ? [...input.dependsOn] : [],
    depth: input.repairOf ? 2 : 1,
    verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria },
    ...(input.registeredScoutEnvelope ? { registeredScoutEnvelope: input.registeredScoutEnvelope } : {}),
    ...(input.repairOf ? { repairOf: input.repairOf } : {}),
  }
}

function failedGraph(options: Readonly<{
  revision?: number
  key?: string
  goal?: string
  createdAt?: Date
  summary?: string
  registeredScoutEnvelope?: StoredTaskGraphNode["registeredScoutEnvelope"]
}> = {}): LoadedGraph {
  const structuredResult = result(options.summary ?? "candidate summary", false)
  const failedReport = report("failed", structuredResult)
  const node = typedNode({
    key: options.key ?? "scout", taskId: "task-scout", goal: options.goal,
    registeredScoutEnvelope: options.registeredScoutEnvelope,
  })
  const storedResult = { structuredResult, taskGraphVerificationReport: failedReport }
  return {
    rootTaskId,
    snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node] },
    item: { id: "task-graph:root-1", revision: options.revision ?? 7, content: {}, createdAt: options.createdAt ?? new Date(1) },
    state: null,
    tasks: new Map<string, GraphTaskRow>([["task-scout", {
      id: "task-scout", status: "failed", role: "scout", failureReason: "task_graph_verification_failed", result: storedResult,
    }]]),
  }
}

function repairedGraph(coveredCriterion: "criterion-a" | "criterion-b"): LoadedGraph {
  const target = typedNode({ key: "scout", taskId: "task-scout" })
  const relation = { graphRootTaskId: rootTaskId, nodeKey: target.key, taskId: target.taskId, criterionIds: [coveredCriterion] }
  const repair = typedNode({ key: "repair", taskId: "task-repair", dependsOn: [target.key], repairOf: relation })
  const repairResult = result("repair result", true)
  const passedReport = {
    ...report("passed", repairResult),
    criteria: criteria.map(item => ({ criterionId: item.id, status: "passed", reasonCode: "criteria_met" })),
  }
  const receipt = {
    schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION,
    graphRootTaskId: rootTaskId,
    targetNodeKey: target.key,
    targetTaskId: target.taskId,
    criterionIds: [coveredCriterion],
    repairNodeKey: repair.key,
    repairTaskId: repair.taskId,
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    evidenceDigest,
  }
  const targetResult = {
    taskGraphVerificationReport: {
      ...report("unverified"),
      criteria: criteria.map(item => ({ criterionId: item.id, status: "unverified", reasonCode: "canonical_evidence_missing" })),
    },
  }
  return {
    rootTaskId,
    snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [target, repair] },
    item: { id: "task-graph:root-1", revision: 7, content: {}, createdAt: new Date(1) },
    state: null,
    tasks: new Map<string, GraphTaskRow>([
      ["task-scout", { id: "task-scout", status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: targetResult }],
      ["task-repair", { id: "task-repair", status: "completed", role: "scout", failureReason: null,
        result: { structuredResult: repairResult, taskGraphVerificationReport: passedReport, taskGraphRepairReceipt: receipt } }],
    ]),
  }
}

describe("TaskGraph terminal assessment checkpoint", () => {
  it("changes for current graph, report and result binding state at the same revision", () => {
    const base = failedGraph()
    const baseline = taskGraphTerminalVerificationDigest(base, rootTaskId)
    expect(baseline).toMatch(/^[a-f0-9]{64}$/)
    expect(taskGraphTerminalVerificationDigest(failedGraph({ key: "scout-revised" }), rootTaskId)).not.toBe(baseline)
    expect(taskGraphTerminalVerificationDigest(failedGraph({ summary: "changed result", revision: 7 }), rootTaskId)).not.toBe(baseline)

    const unverified = { ...base, tasks: new Map(base.tasks) }
    const row = unverified.tasks.get("task-scout")
    if (!row) throw new Error("missing fixture task")
    unverified.tasks.set("task-scout", {
      ...row, failureReason: "task_graph_verification_unverified",
      result: { taskGraphVerificationReport: {
        ...report("unverified"),
      } },
    })
    expect(unverified.item?.revision).toBe(base.item?.revision)
    expect(taskGraphTerminalVerificationDigest(unverified, rootTaskId)).not.toBe(baseline)
  })

  it("binds operative criterion checks and registered Scout contracts at the same revision", () => {
    const base = failedGraph()
    const baseline = taskGraphTerminalVerificationDigest(base, rootTaskId)
    const node = base.snapshot?.nodes[0]
    const verification = node?.verification
    if (!base.snapshot || !node || !verification) throw new Error("missing fixture verification")
    const changedCheck = {
      ...base,
      snapshot: {
        ...base.snapshot,
        nodes: [{
          ...node,
          verification: {
            ...verification,
            criteria: verification.criteria.map((criterion, index) => index === 0
              ? { ...criterion, check: { kind: "candidate_count_gte" as const, minimum: 3 } }
              : criterion),
          },
        }],
      },
    }
    expect(changedCheck.item?.revision).toBe(base.item?.revision)
    expect(taskGraphTerminalVerificationDigest(changedCheck, rootTaskId)).not.toBe(baseline)

    const envelope = {
      role: "scout" as const,
      taskType: "fixture.scout",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" as const },
      allowedActions: ["jobs.search"],
    }
    const registered = failedGraph({ registeredScoutEnvelope: envelope })
    const changedEnvelope = failedGraph({ registeredScoutEnvelope: { ...envelope, allowedActions: ["jobs.get"] } })
    expect(changedEnvelope.item?.revision).toBe(registered.item?.revision)
    expect(taskGraphTerminalVerificationDigest(changedEnvelope, rootTaskId))
      .not.toBe(taskGraphTerminalVerificationDigest(registered, rootTaskId))
  })

  it("omits a denial checkpoint when ordinary or repair task state contradicts its typed report", () => {
    const ordinary = failedGraph()
    const ordinaryTask = ordinary.tasks.get("task-scout")
    if (!ordinaryTask) throw new Error("missing ordinary task")
    const ordinaryStatusMismatch = { ...ordinary, tasks: new Map(ordinary.tasks) }
    ordinaryStatusMismatch.tasks.set("task-scout", { ...ordinaryTask, status: "queued" })
    expect(taskGraphTerminalVerificationDigest(ordinaryStatusMismatch, rootTaskId)).toBeNull()
    const ordinaryFailureMismatch = { ...ordinary, tasks: new Map(ordinary.tasks) }
    ordinaryFailureMismatch.tasks.set("task-scout", { ...ordinaryTask, failureReason: "task_graph_verification_unverified" })
    expect(taskGraphTerminalVerificationDigest(ordinaryFailureMismatch, rootTaskId)).toBeNull()
    const providerErrorMismatch = { ...ordinary, tasks: new Map(ordinary.tasks) }
    providerErrorMismatch.tasks.set("task-scout", { ...ordinaryTask, failureReason: "provider_error" })
    expect(taskGraphTerminalVerificationDigest(providerErrorMismatch, rootTaskId)).toBeNull()
    // Model the unchecked DB status string returned by the current PG row decoder.
    const unknownStatus = {
      ...ordinary,
      tasks: new Map([["task-scout", { ...ordinaryTask, status: "unexpected_db_status" }]]),
    } as unknown as LoadedGraph
    expect(taskGraphTerminalVerificationDigest(unknownStatus, rootTaskId)).toBeNull()

    const failedRepair = repairedGraph("criterion-a")
    const repairTask = failedRepair.tasks.get("task-repair")
    if (!repairTask) throw new Error("missing repair task")
    const failedRepairResult = result("repair result", false)
    const consistentRepair = { ...failedRepair, tasks: new Map(failedRepair.tasks) }
    consistentRepair.tasks.set("task-repair", {
      ...repairTask, status: "failed", failureReason: "task_graph_verification_failed",
      result: { structuredResult: failedRepairResult, taskGraphVerificationReport: report("failed", failedRepairResult) },
    })
    expect(taskGraphTerminalVerificationDigest(consistentRepair, rootTaskId)).toMatch(/^[a-f0-9]{64}$/)
    const repairFailureMismatch = { ...consistentRepair, tasks: new Map(consistentRepair.tasks) }
    const consistentRepairTask = consistentRepair.tasks.get("task-repair")
    if (!consistentRepairTask) throw new Error("missing consistent repair task")
    repairFailureMismatch.tasks.set("task-repair", { ...consistentRepairTask, failureReason: "task_graph_repair_target_unresolved" })
    expect(taskGraphTerminalVerificationDigest(repairFailureMismatch, rootTaskId)).toBeNull()
    const repairStatusMismatch = { ...consistentRepair, tasks: new Map(consistentRepair.tasks) }
    repairStatusMismatch.tasks.set("task-repair", { ...consistentRepairTask, status: "completed", failureReason: null })
    expect(taskGraphTerminalVerificationDigest(repairStatusMismatch, rootTaskId)).toBeNull()

    const unresolvedResult = result("repair result", false)
    const unresolvedReport = {
      ...report("unverified", unresolvedResult),
      reasonCode: "repair_target_unresolved",
      criteria: criteria.map(item => ({ criterionId: item.id, status: "passed" as const, reasonCode: "criteria_met" as const })),
      evidenceDigest: null,
    }
    const unresolvedRepair = { ...failedRepair, tasks: new Map(failedRepair.tasks) }
    unresolvedRepair.tasks.set("task-repair", {
      ...repairTask, status: "failed", failureReason: "task_graph_repair_target_unresolved",
      result: { structuredResult: unresolvedResult, taskGraphVerificationReport: unresolvedReport },
    })
    expect(taskGraphTerminalVerificationDigest(unresolvedRepair, rootTaskId)).toMatch(/^[a-f0-9]{64}$/)
    const unresolvedReasonMismatch = { ...unresolvedRepair, tasks: new Map(unresolvedRepair.tasks) }
    const unresolvedTask = unresolvedRepair.tasks.get("task-repair")
    if (!unresolvedTask) throw new Error("missing unresolved repair task")
    unresolvedReasonMismatch.tasks.set("task-repair", { ...unresolvedTask, failureReason: "task_graph_verification_unverified" })
    expect(taskGraphTerminalVerificationDigest(unresolvedReasonMismatch, rootTaskId)).toBeNull()
  })

  it("binds repair relation and receipt state, while ignoring goal and storage timestamp noise", () => {
    const firstReceipt = taskGraphTerminalVerificationDigest(repairedGraph("criterion-a"), rootTaskId)
    const changedReceipt = taskGraphTerminalVerificationDigest(repairedGraph("criterion-b"), rootTaskId)
    expect(firstReceipt).toMatch(/^[a-f0-9]{64}$/)
    expect(changedReceipt).toMatch(/^[a-f0-9]{64}$/)
    expect(changedReceipt).not.toBe(firstReceipt)

    const base = failedGraph()
    const proseAndTimeNoise = failedGraph({
      revision: 7,
      goal: "A different candidate-facing description.",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    })
    expect(taskGraphTerminalVerificationDigest(proseAndTimeNoise, rootTaskId))
      .toBe(taskGraphTerminalVerificationDigest(base, rootTaskId))
    expect(buildTaskGraphDenialCheckpoint(base, rootTaskId))
      .toEqual(buildTaskGraphDenialCheckpoint(proseAndTimeNoise, rootTaskId))
  })

  it("binds the checkpoint to the exact root and refuses malformed current assessment", () => {
    const checkpoint = buildTaskGraphDenialCheckpoint(failedGraph(), rootTaskId)
    expect(checkpoint).toMatchObject({ schemaVersion: expect.any(String), taskId: rootTaskId, graphRevision: 7 })
    expect(parseTaskGraphDenialCheckpoint(checkpoint, rootTaskId)).toEqual(checkpoint)
    expect(parseTaskGraphDenialCheckpoint(checkpoint, "foreign-root")).toBeNull()
    expect(buildTaskGraphDenialCheckpoint(failedGraph(), "foreign-root")).toBeNull()
    expect(buildTaskGraphDenialCheckpoint(failedGraph({ revision: 0 }), rootTaskId)).toBeNull()
  })
})
