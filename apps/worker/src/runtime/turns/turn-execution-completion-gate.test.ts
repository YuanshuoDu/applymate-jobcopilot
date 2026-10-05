import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertCompletionAllowed, checkTaskGraphTerminalVerification } from "./turn-execution-completion-gate.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "../subagents/task-graph-snapshot.js"

type GateOptions = Pick<TurnExecutionOptions, "identity" | "scope" | "completionGate">
type GateWriter = Pick<TurnExecutionEventWriter, "append">

const identity: TurnExecutionOptions["identity"] = {
  kind: "turn",
  taskId: "task-1",
  rootTaskId: "root-1",
  userId: "user-1",
  sessionId: "session-1",
  turnId: "turn-1",
  ownerId: "owner-1",
  leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
  leaseVersion: 1,
}
const step: TurnEngineStep = { id: "step-1", ordinal: 0 }
const nowValue = new Date("2026-09-24T12:00:00.000Z")

function gateOptions(completionGate: NonNullable<TurnExecutionOptions["completionGate"]>): GateOptions {
  return { identity, scope: { userId: identity.userId }, completionGate }
}

function gateWriter(): GateWriter {
  return { append: vi.fn(async (..._args: Parameters<GateWriter["append"]>) => "event-1") }
}

describe("assertCompletionAllowed", () => {
  it("allows a successful decision without writing a rejection event", async () => {
    const completionGate = vi.fn(async () => ({ ok: true as const }))
    const writer = gateWriter()
    const signal = new AbortController().signal

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, signal, () => nowValue)).resolves.toBeUndefined()

    expect(completionGate).toHaveBeenCalledWith({ identity, scope: { userId: identity.userId }, rootTaskId: identity.rootTaskId, stepId: step.id, signal, now: nowValue })
    expect(writer.append).not.toHaveBeenCalled()
  })

  it("writes the blocker event and rejects a denied decision", async () => {
    const completionGate = vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child work is still running" }))
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ code: "business_precondition_failed", message: "child_tasks_pending" })

    expect(writer.append).toHaveBeenCalledWith(
      "final.rejected", step.id, null,
      { code: "business_precondition_failed", blocker: "child_tasks_pending", feedback: "Child work is still running", taskId: identity.taskId },
      `final-rejected:${step.id}`,
    )
  })

  it("fails closed on a malformed decision", async () => {
    const completionGate = vi.fn(async () => ({ ok: "yes" } as unknown as Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>))
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ code: "invalid_output", message: "Completion gate returned an invalid decision" })
    expect(writer.append).not.toHaveBeenCalled()
  })

  it("fails closed when the gate throws", async () => {
    const completionGate = vi.fn(async () => { throw new Error("store unavailable") })
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ name: "TurnEngineError", code: "invalid_output", message: "Completion gate failed closed" })
    expect(writer.append).not.toHaveBeenCalled()
  })
})

const graphLease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseStartedAt: nowValue, leaseExpiresAt: new Date(nowValue.getTime() + 60_000) }
const check = { kind: "candidate_count_gte", minimum: 1 }
const contract = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: [{ id: "candidate-present", check }] }
const digest = "a".repeat(64)
function node(key: string, taskId: string, repairOf?: unknown) {
  return { key, taskId, templateId: "scout", goal: "Find evidence", successCriteria: ["Find one candidate"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: contract, ...(repairOf ? { repairOf } : {}) }
}
function structuredResult(status: "passed" | "failed") {
  return { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
    candidates: status === "passed" ? [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["read:job:job-1"] }] : [],
    evidence: status === "passed" ? [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }] : [], summary: "Verified" }
}
function report(status: "passed" | "failed" | "unverified") {
  const criterion = status === "passed"
    ? { criterionId: "candidate-present", status, reasonCode: "criteria_met" }
    : { criterionId: "candidate-present", status, reasonCode: status === "failed" ? "criterion_not_met" : "canonical_evidence_missing" }
  const resultDigest = status === "unverified" ? null : taskGraphResultDigest(structuredResult(status))
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode: criterion.reasonCode, criteria: [criterion], evidenceDigest: status === "unverified" ? null : digest, resultDigest }
}
function storedResult(status: "passed" | "failed" | "unverified") {
  return { taskGraphVerificationReport: report(status), ...(status === "unverified" ? {} : { structuredResult: structuredResult(status) }) }
}
function graphClient(nodes: unknown[], tasks: Array<Record<string, unknown>>) {
  const content = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM "agent_items" AS item')) return { rows: [{ id: "graph-item", revision: 1, content }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: tasks, rowCount: tasks.length }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected graph query: ${sql}`)
  }) } as never
}

describe("TaskGraph terminal verification gate", () => {
  it("fails closed for legacy-unverified and missing durable reports", async () => {
    const legacy = node("legacy", "task-legacy") as Record<string, unknown>
    delete legacy.verification; legacy.verificationDisposition = "legacy_unverified"
    const cases: Array<[unknown[], Array<Record<string, unknown>>]> = [
      [[legacy], [{ id: "task-legacy", status: "completed", role: "scout", failureReason: null, result: null }]],
      [[node("scout", "task-scout")], [{ id: "task-scout", status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: storedResult("unverified") }]],
    ]
    for (const [graphNodes, tasks] of cases) {
      const decision = await checkTaskGraphTerminalVerification(graphClient(graphNodes, tasks), graphLease, "root-1")
      expect(decision).toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    }
  })

  it("returns bounded criterion feedback from the validated report without role-result contents", async () => {
    const target = node("scout", "task-scout"), sensitiveResult = { ...structuredResult("failed"), summary: "private alice@example.com" }
    const verifiedReport = { ...report("failed"), resultDigest: taskGraphResultDigest(sensitiveResult) }
    const decision = await checkTaskGraphTerminalVerification(graphClient([target], [{ id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed", result: { structuredResult: sensitiveResult, taskGraphVerificationReport: verifiedReport } }]), graphLease, "root-1")
    expect(decision).toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    if (decision.ok) return
    expect(decision.feedback).toContain("node=scout criterion=candidate-present status=failed reasonCode=criterion_not_met")
    expect(decision.feedback.length).toBeLessThanOrEqual(512)
    expect(decision.feedback).not.toContain("alice@example.com")
  })

  it("redacts credential-like node and criterion IDs before durable feedback", async () => {
    const secretId = "sk-abcdefgh", result = structuredResult("failed")
    const target = { ...node(secretId, "task-scout"), verification: { ...contract, criteria: [{ id: secretId, check }] } }
    const verifiedReport = { ...report("failed"), criteria: [{ criterionId: secretId, status: "failed", reasonCode: "criterion_not_met" }] }
    const decision = await checkTaskGraphTerminalVerification(graphClient([target], [{ id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed", result: { structuredResult: result, taskGraphVerificationReport: verifiedReport } }]), graphLease, "root-1")
    expect(decision).toMatchObject({ ok: false })
    if (decision.ok) return
    expect(decision.feedback).toContain("node=redacted criterion=redacted status=failed reasonCode=criterion_not_met")
    expect(decision.feedback).not.toContain(secretId)
  })

  it("reports the trusted criterion reason when its repair is missing", async () => {
    const target = node("scout", "task-scout")
    const decision = await checkTaskGraphTerminalVerification(graphClient([target], [{ id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: storedResult("unverified") }]), graphLease, "root-1")
    expect(decision).toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    if (decision.ok) return
    expect(decision.feedback).toContain("node=scout criterion=candidate-present status=unverified reasonCode=canonical_evidence_missing repair=missing")
  })

  it("marks report-less repairs as missing and queued or running repairs as pending", async () => {
    const target = node("scout", "task-scout"), relation = { graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-present"] }
    const repair = node("repair", "task-repair", relation), targetTask = { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: storedResult("unverified") }
    const absent = await checkTaskGraphTerminalVerification(graphClient([target, repair], [targetTask]), graphLease, "root-1")
    expect(absent).toMatchObject({ ok: false })
    if (absent.ok) return
    expect(absent.feedback).not.toContain("invalid_report")
    const missing = await checkTaskGraphTerminalVerification(graphClient([target, repair], [targetTask, { id: repair.taskId, status: "failed", role: "scout", failureReason: "worker_failed", result: null }]), graphLease, "root-1")
    expect(missing).toMatchObject({ ok: false })
    if (missing.ok) return
    expect(missing.feedback).toContain("node=scout criterion=candidate-present status=unverified reasonCode=canonical_evidence_missing repair=missing")
    expect(missing.feedback).not.toContain("repair=invalid_report")
    expect(missing.feedback.length).toBeLessThanOrEqual(512)
    const pending = await checkTaskGraphTerminalVerification(graphClient([target, repair], [targetTask, { id: repair.taskId, status: "running", role: "scout", failureReason: null, result: null }]), graphLease, "root-1")
    expect(pending).toMatchObject({ ok: false })
    if (pending.ok) return
    expect(pending.feedback).toContain("repair=pending")
    expect(pending.feedback).not.toContain("repair=invalid_report")
  })

  it("accepts nullable unverified receipts for repair but rejects unknown reason codes", async () => {
    const target = node("scout", "task-scout")
    const relation = { graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-present"] }
    const repair = node("scout-repair", "task-repair", relation)
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1", targetNodeKey: target.key, targetTaskId: target.taskId, criterionIds: relation.criterionIds, repairNodeKey: repair.key, repairTaskId: repair.taskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: digest }
    const tasks = [
      { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: storedResult("unverified") },
      { id: repair.taskId, status: "completed", role: "scout", failureReason: null, result: { ...storedResult("passed"), taskGraphRepairReceipt: receipt } },
    ]
    await expect(checkTaskGraphTerminalVerification(graphClient([target, repair], tasks), graphLease, "root-1")).resolves.toEqual({ ok: true })
    const forged = [{ ...tasks[0], result: { ...storedResult("unverified"), taskGraphVerificationReport: { ...report("unverified"), reasonCode: "worker_claim", criteria: [{ criterionId: "candidate-present", status: "unverified", reasonCode: "worker_claim" }] } } }, tasks[1]]
    const forgedDecision = await checkTaskGraphTerminalVerification(graphClient([target, repair], forged), graphLease, "root-1")
    expect(forgedDecision).toMatchObject({ ok: false, feedback: expect.stringContaining("scout:verification_report") })
    if (forgedDecision.ok) return
    expect(forgedDecision.feedback).not.toContain("worker_claim")
    expect(forgedDecision.feedback).not.toContain("criterion=candidate-present")
  })

  it("accepts only a complete passing repair receipt for the failed criteria", async () => {
    const target = node("scout", "task-scout")
    const relation = { graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-present"] }
    const repair = node("scout-repair", "task-repair", relation)
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1", targetNodeKey: target.key, targetTaskId: target.taskId, criterionIds: relation.criterionIds, repairNodeKey: repair.key, repairTaskId: repair.taskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: digest }
    const baseTasks = [
      { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed", result: storedResult("failed") },
      { id: repair.taskId, status: "completed", role: "scout", failureReason: null, result: { ...storedResult("passed"), taskGraphRepairReceipt: receipt } },
    ]
    await expect(checkTaskGraphTerminalVerification(graphClient([target, repair], baseTasks), graphLease, "root-1")).resolves.toEqual({ ok: true })
    const forged = [{ ...baseTasks[0] }, { ...baseTasks[1], result: { ...storedResult("passed"), taskGraphRepairReceipt: { ...receipt, targetTaskId: "foreign-task" } } }]
    const forgedDecision = await checkTaskGraphTerminalVerification(graphClient([target, repair], forged), graphLease, "root-1")
    expect(forgedDecision).toMatchObject({ ok: false, feedback: expect.stringContaining("scout-repair:repair_receipt") })
    if (forgedDecision.ok) return
    expect(forgedDecision.feedback).toContain("node=scout criterion=candidate-present status=failed reasonCode=criterion_not_met repair=invalid_receipt")
    const invalidRepair = { ...baseTasks[1], status: "failed", failureReason: "task_graph_verification_unverified", result: { taskGraphVerificationReport: { ...report("unverified"), reasonCode: "worker_claim", criteria: [{ criterionId: "candidate-present", status: "unverified", reasonCode: "worker_claim" }] } } }
    const invalidReportDecision = await checkTaskGraphTerminalVerification(graphClient([target, repair], [baseTasks[0]!, invalidRepair]), graphLease, "root-1")
    expect(invalidReportDecision).toMatchObject({ ok: false })
    if (invalidReportDecision.ok) return
    expect(invalidReportDecision.feedback).toContain("node=scout criterion=candidate-present status=failed reasonCode=criterion_not_met repair=invalid_report")
    expect(invalidReportDecision.feedback).not.toContain("worker_claim")
  })

  it("lets a later valid repair resolve a previously rejected repair without mutating its failed row", async () => {
    const target = node("scout", "task-scout"), relation = { graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-present"] }
    const rejected = node("repair-first", "task-repair-first", relation), repair = node("repair-second", "task-repair-second", relation)
    const rejectedReport = { ...report("passed"), status: "unverified", reasonCode: "repair_target_unresolved", evidenceDigest: null }
    const receipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1", targetNodeKey: target.key, targetTaskId: target.taskId,
      criterionIds: relation.criterionIds, repairNodeKey: repair.key, repairTaskId: repair.taskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: digest }
    const tasks = [
      { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_failed", result: storedResult("failed") },
      { id: rejected.taskId, status: "failed", role: "scout", failureReason: "task_graph_repair_target_unresolved", result: { structuredResult: structuredResult("passed"), taskGraphVerificationReport: rejectedReport } },
      { id: repair.taskId, status: "completed", role: "scout", failureReason: null, result: { ...storedResult("passed"), taskGraphRepairReceipt: receipt } },
    ]
    await expect(checkTaskGraphTerminalVerification(graphClient([target, rejected, repair], tasks), graphLease, "root-1")).resolves.toEqual({ ok: true })
    const unresolved = await checkTaskGraphTerminalVerification(graphClient([target, rejected], tasks.slice(0, 2)), graphLease, "root-1")
    expect(unresolved).toMatchObject({ ok: false })
    if (unresolved.ok) return
    expect(unresolved.feedback).toContain("node=repair-first status=unverified reasonCode=repair_target_unresolved")
    const rejectedResult = tasks[1]!.result as Record<string, unknown>
    const forged = [{ ...tasks[0] }, { ...tasks[1], result: { ...rejectedResult, taskGraphRepairReceipt: { ...receipt, targetTaskId: "foreign" } } }, tasks[2]!]
    await expect(checkTaskGraphTerminalVerification(graphClient([target, rejected, repair], forged), graphLease, "root-1")).resolves.toMatchObject({ ok: false })
  })

  it("reports omitted criteria explicitly and prioritizes a repair's own reason", async () => {
    const criterionIds = Array.from({ length: 8 }, (_, index) => `criterion-${index}-${"x".repeat(52)}`)
    const multiContract = { ...contract, criteria: criterionIds.map(id => ({ id, check })) }
    const target = { ...node("scout", "task-scout"), verification: multiContract }
    const relation = { graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds }
    const repair = { ...node("repair-first", "task-repair", relation), verification: multiContract }
    const targetReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "canonical_evidence_missing", criteria: criterionIds.map(criterionId => ({ criterionId, status: "unverified", reasonCode: "canonical_evidence_missing" })), evidenceDigest: null, resultDigest: null }
    const repairResult = structuredResult("passed")
    const repairReport = { ...report("passed"), status: "unverified", reasonCode: "repair_target_unresolved", criteria: criterionIds.map(criterionId => ({ criterionId, status: "passed", reasonCode: "criteria_met" })), evidenceDigest: null, resultDigest: taskGraphResultDigest(repairResult) }
    const tasks = [
      { id: target.taskId, status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", result: { taskGraphVerificationReport: targetReport } },
      { id: repair.taskId, status: "failed", role: "scout", failureReason: "task_graph_repair_target_unresolved", result: { structuredResult: repairResult, taskGraphVerificationReport: repairReport } },
    ]
    const decision = await checkTaskGraphTerminalVerification(graphClient([target, repair], tasks), graphLease, "root-1")
    expect(decision).toMatchObject({ ok: false })
    if (decision.ok) return
    expect(decision.feedback).toContain("node=repair-first status=unverified reasonCode=repair_target_unresolved")
    expect(decision.feedback).toMatch(/\d+ feedback items omitted; inspect TaskGraph before retrying/)
    expect(decision.feedback.length).toBeLessThanOrEqual(512)
  })
})
