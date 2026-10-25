import { beforeEach, describe, expect, it, vi } from "vitest"
import { turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import type { DurableWaitInvocation, DurableWaitResult, DurableWaitScheduledGateInvocation } from "../tools/coordination-types.js"

const mock = vi.hoisted(() => ({ selectResume: vi.fn(), readCandidate: vi.fn(),
}))
vi.mock("./scheduled-gate-resume-wait.js", () => ({ selectScheduledGateResumeWaitAttempt: mock.selectResume }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ readScheduledGateQuestionCandidate: mock.readCandidate }))

import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-owner", turnLeaseVersion: 4 }
const executionOwner = { kind: "turn" as const, ...owner, taskId: owner.rootTaskId, ownerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion }
const prepareProof = { receipt: { continuationKey: "continuation-1" }, completion: { graphRevision: 8 } }
const continuation = { owner, executionOwner, attestation: { graphRevision: 7, snapshotDigest: "sha256:" + "b".repeat(64) }, handoff: { executionId: "execution-1", executionAttemptCount: 3 },
  prepareProof, scheduledWaitId: "prepare-choice-wait", finalStepId: "root-final-step", signal: new AbortController().signal }
const binding: TurnQuestionGateChoiceBinding = { schemaVersion: "agent-harness.v2.scheduled-gate-choice-wait.v1",
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: "execution-1", executionAttemptCount: 3 },
  continuationKey: "scheduled-taskgraph:sha256:" + "a".repeat(64), snapshotDigest: "sha256:" + "b".repeat(64),
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, graphRevision: 12,
  gateTaskId: "gate-task", gateAttempt: 2, kind: "weak_cover_letter", jobIds: ["job-2"],
  allowedChoiceIds: ["continue", "review", "skip"] }
const gateProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 18,
  prepareProof, gate: { taskId: "gate-task", attemptCount: 3, resultDigest: "sha256:" + "e".repeat(64), completedEventRevision: 18 } }
const auditReport = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 7 }
function auditReceipt(expectedAttemptCount = 1) {
  return { status: "accepted" as const, revision: 19, nodes: [{ key: "scheduled_audit", taskId: "audit-task", status: "queued" as const }],
    readyTaskIds: ["audit-task"], auditTaskId: "audit-task", expectedAttemptCount }
}
function auditCompletionProof(attemptCount = 1) {
  return { schemaVersion: "agent-harness.v2.scheduled-taskgraph-audit-completion.v1", owner: {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: "execution-1", executionAttemptCount: 3,
  }, snapshotDigest: continuation.attestation.snapshotDigest, graphRevision: 19, gateProof,
  audit: { taskId: "audit-task", attemptCount, resultDigest: "sha256:" + "f".repeat(64), completedEventRevision: 19 }, report: auditReport }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const dbClient = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() }
  const pool = { connect: vi.fn(async () => dbClient) }
  const commandPort = {
    appendScheduledGate: vi.fn(async () => ({ status: "accepted", revision: 9, nodes: [{ key: "gate", taskId: "gate-task" }], readyTaskIds: ["gate-task"] })),
    resumeScheduledGateChoice: vi.fn(async () => ({ status: "accepted", taskId: "gate-task", requestAttemptCount: 2,
      resumedAttemptCount: 3, revision: 16, readyTaskIds: ["gate-task"] })),
    verifyScheduledGateCompletion: vi.fn(async () => gateProof),
    appendScheduledAudit: vi.fn(async () => auditReceipt()),
    verifyScheduledAuditCompletion: vi.fn(async () => auditCompletionProof()),
    ...overrides,
  }
  const waitPort = { waitScheduledGate: vi.fn(async (_invocation: DurableWaitScheduledGateInvocation) =>
    ({ waitId: "durable-gate-wait", status: "ready" as const, deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["gate-task"] })),
  wait: vi.fn(async (_invocation: DurableWaitInvocation): Promise<DurableWaitResult> =>
      ({ waitId: "durable-audit-wait", status: "ready" as const, deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["audit-task"] })) }
  return { dbClient, pool, commandPort, waitPort }
}

describe("scheduled automation Gate continuation", () => {
  beforeEach(() => { mock.selectResume.mockReset(); mock.readCandidate.mockReset() })

  it("verifies Gate before appending Audit and waits for that exact child", async () => {
    mock.selectResume.mockResolvedValue({ status: "resumed", requestAttemptCount: 2 })
    mock.readCandidate.mockResolvedValueOnce({ question: { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-2"],
      candidateSetDigest: "sha256:" + "f".repeat(64), allowedChoiceIds: ["continue", "review", "skip"] }, binding }).mockResolvedValueOnce(null)
    const deps = dependencies(), questionStore = { readScheduledGateChoice: vi.fn(async () => ({ status: "answered", waitId: "private-question-wait",
      itemId: "private-question-item", binding, validatedChoice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: "skip" } })) }
    const run = createScheduledAutomationGateContinuation({ ...deps, questionStore, nativeQuestionWaitEnabled: true,
      now: () => new Date("2026-10-23T12:00:00.000Z") } as never)

    await expect(run(continuation as never)).resolves.toEqual({ status: "completed" })
    expect(deps.commandPort.appendScheduledGate).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({ expectedRevision: 8 }),
    }))
    expect(deps.waitPort.waitScheduledGate).toHaveBeenCalledTimes(2)
    expect(deps.waitPort.waitScheduledGate.mock.calls.map(([call]) => call.requestAttemptCount)).toEqual([2, 2])
    expect(deps.commandPort.resumeScheduledGateChoice).toHaveBeenCalledWith(expect.objectContaining({
      gateTaskId: "gate-task", requestAttemptCount: 2, waitId: "private-question-wait",
    }))
    expect(deps.commandPort.appendScheduledAudit).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ stepId: "root-final-step" }), gateProof, scheduledWaitId: "prepare-choice-wait",
    }))
    expect(deps.waitPort.wait).toHaveBeenCalledWith(expect.objectContaining({ targetTaskIds: ["audit-task"], mode: "all",
      stepId: "root-final-step", idempotencyKey: expect.stringMatching(/^scheduled-audit-wait:/) }))
    expect(deps.commandPort.verifyScheduledAuditCompletion).toHaveBeenCalledWith(expect.objectContaining({
      auditTaskId: "audit-task", attemptCount: 1, gateProof,
    }))
    expect(deps.commandPort.verifyScheduledGateCompletion.mock.invocationCallOrder[0])
      .toBeLessThan(deps.commandPort.appendScheduledAudit.mock.invocationCallOrder[0]!)
    expect(deps.commandPort.appendScheduledAudit.mock.invocationCallOrder[0])
      .toBeLessThan(deps.waitPort.wait.mock.invocationCallOrder[0]!)
    expect(deps.waitPort.wait.mock.invocationCallOrder[0])
      .toBeLessThan(deps.commandPort.verifyScheduledAuditCompletion.mock.invocationCallOrder[0]!)
  })

  it("does not append Audit when exact Gate completion proof is missing", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue(null)
    const deps = dependencies()
    deps.commandPort.verifyScheduledGateCompletion.mockResolvedValueOnce(null as never)
    const run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: true } as never)

    await expect(run(continuation as never)).resolves.toEqual({ status: "blocked", errorCode: "scheduled_gate_completion_unverified" })
    expect(deps.commandPort.appendScheduledAudit).not.toHaveBeenCalled()
    expect(deps.waitPort.wait).not.toHaveBeenCalled()
  })

  it("returns a dependency wait when the exact Audit task has not woken yet", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue(null)
    const deps = dependencies()
    deps.waitPort.wait.mockResolvedValue({ waitId: "durable-audit-wait", status: "waiting", deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: [] })
    const run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: true } as never)

    await expect(run(continuation as never)).resolves.toEqual({ status: "waiting_for_dependency", waitId: "durable-audit-wait" })
    expect(deps.waitPort.wait).toHaveBeenCalledWith(expect.objectContaining({ targetTaskIds: ["audit-task"] }))
    expect(deps.commandPort.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("treats a ready wake for another task as invalid", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue(null)
    const deps = dependencies()
    deps.waitPort.wait.mockResolvedValueOnce({ waitId: "wrong-wake", status: "ready", deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["gate-task"] })
    const run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: true } as never)

    await expect(run(continuation as never)).resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_wait_invalid" })
    expect(deps.commandPort.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("uses a new exact-child wait key for a retry attempt and rejects an old attempt's ready proof", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue(null)
    const deps = dependencies()
    deps.commandPort.appendScheduledAudit.mockResolvedValueOnce(auditReceipt(1)).mockResolvedValueOnce(auditReceipt(2))
    deps.waitPort.wait.mockResolvedValueOnce({ waitId: "audit-wait-1", status: "waiting", deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: [] })
      .mockResolvedValueOnce({ waitId: "audit-wait-2", status: "ready", deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["audit-task"] })
    deps.commandPort.verifyScheduledAuditCompletion.mockResolvedValueOnce(auditCompletionProof(1))
    const run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: true } as never)

    await expect(run(continuation as never)).resolves.toEqual({ status: "waiting_for_dependency", waitId: "audit-wait-1" })
    await expect(run(continuation as never)).resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_completion_unverified" })

    const waitCalls = deps.waitPort.wait.mock.calls.map(([invocation]) => invocation)
    expect(waitCalls.map(call => call.targetTaskIds)).toEqual([["audit-task"], ["audit-task"]])
    expect(waitCalls.map(call => call.idempotencyKey)[0]).not.toBe(waitCalls.map(call => call.idempotencyKey)[1])
    expect(deps.commandPort.verifyScheduledAuditCompletion).toHaveBeenCalledWith(expect.objectContaining({
      auditTaskId: "audit-task", attemptCount: 2,
    }))
  })

  it("persists an unanswered exact current question only through the existing enabled Turn wait capability", async () => {
    const questionBinding = { ...binding, gateAttempt: 1 }
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue({ question: { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-1"],
      candidateSetDigest: "sha256:" + "f".repeat(64), allowedChoiceIds: ["continue", "review", "skip"] }, binding: questionBinding })
    const deps = dependencies(), questionStore = { readScheduledGateChoice: vi.fn(async () => ({ status: "waiting", waitId: "private-wait",
      itemId: "private-item", binding: questionBinding })) }
    const run = createScheduledAutomationGateContinuation({ ...deps, questionStore, nativeQuestionWaitEnabled: true } as never)

    const result = await run(continuation as never)
    expect(result).toEqual({ status: "waiting_for_choice", waitId: turnScheduledGateChoiceWaitId(questionBinding),
      question: "A prepared application has a weak cover letter. How should I handle it?", binding: questionBinding })
    expect(deps.waitPort.waitScheduledGate).toHaveBeenCalledWith(expect.objectContaining({ requestAttemptCount: 0 }))
    expect(deps.commandPort.resumeScheduledGateChoice).not.toHaveBeenCalled()
    expect(deps.commandPort.appendScheduledAudit).not.toHaveBeenCalled()
  })

  it("fails closed if a question is found while native Turn question persistence is unavailable", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue({ question: {}, binding })
    const deps = dependencies(), run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: false } as never)
    await expect(run(continuation as never)).resolves.toEqual({ status: "blocked", errorCode: "scheduled_gate_question_wait_unavailable" })
    expect(deps.commandPort.resumeScheduledGateChoice).not.toHaveBeenCalled()
  })
})
