import { beforeEach, describe, expect, it, vi } from "vitest"
import { turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import type { DurableWaitScheduledGateInvocation } from "../tools/coordination-types.js"

const mock = vi.hoisted(() => ({ selectResume: vi.fn(), readCandidate: vi.fn(),
  execute: vi.fn<(input: unknown, signal: AbortSignal, fetcher?: typeof fetch) => Promise<{ status: "completed" }>>() }))
vi.mock("./scheduled-gate-resume-wait.js", () => ({ selectScheduledGateResumeWaitAttempt: mock.selectResume }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ readScheduledGateQuestionCandidate: mock.readCandidate }))
vi.mock("./scheduled-pipeline-handoff.js", () => ({ postScheduledPipelineExecute: mock.execute }))

import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-owner", turnLeaseVersion: 4 }
const executionOwner = { kind: "turn" as const, ...owner, taskId: owner.rootTaskId, ownerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion }
const prepareProof = { receipt: { continuationKey: "continuation-1" }, completion: { graphRevision: 8 } }
const continuation = { owner, executionOwner, attestation: { graphRevision: 7 }, handoff: { executionId: "execution-1", executionAttemptCount: 3 },
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

function dependencies(overrides: Record<string, unknown> = {}) {
  const dbClient = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() }
  const pool = { connect: vi.fn(async () => dbClient) }
  const commandPort = {
    appendScheduledGate: vi.fn(async () => ({ status: "accepted", revision: 9, nodes: [{ key: "gate", taskId: "gate-task" }], readyTaskIds: ["gate-task"] })),
    resumeScheduledGateChoice: vi.fn(async () => ({ status: "accepted", taskId: "gate-task", requestAttemptCount: 2,
      resumedAttemptCount: 3, revision: 16, readyTaskIds: ["gate-task"] })),
    verifyScheduledGateCompletion: vi.fn(async () => gateProof),
    ...overrides,
  }
  const waitPort = { waitScheduledGate: vi.fn(async (_invocation: DurableWaitScheduledGateInvocation) =>
    ({ waitId: "durable-gate-wait", status: "ready" as const, matchedTaskIds: ["gate-task"] })) }
  return { dbClient, pool, commandPort, waitPort }
}

describe("scheduled automation Gate continuation", () => {
  beforeEach(() => { mock.selectResume.mockReset(); mock.readCandidate.mockReset(); mock.execute.mockReset() })

  it("resumes from the exact acknowledged attempt and forwards only the validated Prepare wait to Execute", async () => {
    mock.selectResume.mockResolvedValue({ status: "resumed", requestAttemptCount: 2 })
    mock.readCandidate.mockResolvedValueOnce({ question: { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-2"],
      candidateSetDigest: "sha256:" + "f".repeat(64), allowedChoiceIds: ["continue", "review", "skip"] }, binding }).mockResolvedValueOnce(null)
    mock.execute.mockResolvedValue({ status: "completed" })
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
    expect(mock.execute).toHaveBeenCalledWith(expect.objectContaining({ scheduledWaitId: "prepare-choice-wait", gateCompletionProof: gateProof }),
      expect.any(AbortSignal), undefined)
    expect(mock.execute.mock.calls[0]?.[0]).not.toHaveProperty("waitId")
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
    expect(mock.execute).not.toHaveBeenCalled()
  })

  it("fails closed if a question is found while native Turn question persistence is unavailable", async () => {
    mock.selectResume.mockResolvedValue({ status: "initial" })
    mock.readCandidate.mockResolvedValue({ question: {}, binding })
    const deps = dependencies(), run = createScheduledAutomationGateContinuation({ ...deps, nativeQuestionWaitEnabled: false } as never)
    await expect(run(continuation as never)).resolves.toEqual({ status: "blocked", errorCode: "scheduled_gate_question_wait_unavailable" })
    expect(deps.commandPort.resumeScheduledGateChoice).not.toHaveBeenCalled()
  })
})
