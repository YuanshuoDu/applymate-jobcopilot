import { beforeEach, describe, expect, it, vi } from "vitest"
import { appendScheduledPrepare } from "./pg-scheduled-task-graph-prepare-command.js"
import { taskGraphProposalKey } from "./task-graph-snapshot.js"
import type { TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"

const mocks = vi.hoisted(() => ({
  continuation: vi.fn(), claim: vi.fn(), snapshot: vi.fn(), analyze: vi.fn(), replay: vi.fn(), receiptMatches: vi.fn(), readReceipt: vi.fn(),
  lock: vi.fn(), load: vi.fn(), current: vi.fn(), budget: vi.fn(), create: vi.fn(), appendReceipt: vi.fn(),
  writePlanReceipt: vi.fn(), choiceBinding: vi.fn(), choiceItem: vi.fn(), enqueue: vi.fn(),
}))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", () => ({
  createScheduledTaskGraphContinuationContract: mocks.continuation,
  scheduledTaskGraphClaimMatches: mocks.claim,
  scheduledSnapshotMatches: mocks.snapshot,
  scheduledAnalyzeGraphMatches: mocks.analyze,
  scheduledPrepareReplayReceipt: mocks.replay,
  scheduledTaskGraphContinuationReceiptMatches: mocks.receiptMatches,
  readScheduledPrepareReceipt: mocks.readReceipt,
  SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT: "agent.plan.scheduled_prepare_binding",
}))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load, currentTaskGraph: mocks.current }))
vi.mock("../turns/turn-engine-root-budget.js", () => ({ enforceRootStepBudget: mocks.budget }))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: mocks.create, enqueueGraphTask: mocks.enqueue }))
vi.mock("./task-graph-pg-events.js", () => ({ appendTaskGraphReceipt: mocks.appendReceipt, writePlanReceipt: mocks.writePlanReceipt }))
vi.mock("../turns/turn-question-store-events.js", () => ({ loadScheduledChoiceBinding: mocks.choiceBinding }))
vi.mock("../turns/turn-question-contract.js", () => ({ parseTurnScheduledPrepareChoiceItem: mocks.choiceItem }))
vi.mock("../turns/turn-question-store-guards.js", () => ({ questionItemId: (waitId: string) => `agent-wait:question:${waitId}` }))

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 3 }
const binding = { owner, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, prepareScheduleRevision: 8 }
const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", ...binding }
const contract = { binding, receipt, bindingDigest: "e".repeat(64), proposalFingerprint: "f".repeat(64), claimTokenDigest: `sha256:${"1".repeat(64)}` }
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, stepId: "final-step", turnLeaseOwner: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion,
  parentLeaseOwner: owner.turnLeaseOwnerId, parentAttemptCount: owner.rootAttemptCount }
const proposal = { expectedRevision: 7, nodes: [{ key: "prepare", templateId: "prepare", goal: "Prepare the selected jobs",
  successCriteria: ["Create verified materials"], dependsOn: ["analyst"] }] }
const input = { scope, executionOwner: { executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  handoff: { status: "analyze_checkpointed", continuationKey: binding.continuationKey, checkpointDigest: binding.checkpointDigest,
    claimTokenDigest: contract.claimTokenDigest, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  attestation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1" }, proposal } as unknown as TaskGraphScheduledPrepareInput
const parent = { id: owner.rootTaskId }
const loaded = { item: { revision: 7 }, state: { revision: 7 }, snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1",
  nodes: [{ key: "scout", taskId: "scout-task" }, { key: "analyst", taskId: "analyst-task" }] }, tasks: new Map() }
const current = { revision: 7, nodes: [] }
const scheduled = { state: { revision: 8 }, snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", nodes: [] },
  created: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] }
const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"], targetLocations: [],
  minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false }
const choiceWaitId = "agent-question:turn-1:canonical:wait"
const choiceBinding = { schemaVersion: "agent-harness.v2.turn-scheduled-prepare-choice.v1", owner, continuationKey: binding.continuationKey,
  snapshotDigest: binding.snapshotDigest, evidenceDigest: binding.evidenceDigest, checkpointDigest: binding.checkpointDigest,
  analyzeGraphRevision: binding.analyzeGraphRevision, prepareScheduleRevision: binding.prepareScheduleRevision,
  finalStepId: "final-step", finalStepOrdinal: 2, finalStepAttempt: 1 }
let requireApproval = true
let persistedQuestion: Record<string, unknown> | null = null
let turnLeaseOwner = scope.turnLeaseOwner
let candidateStepStatus = "streaming"
const client = { query: vi.fn(async (sql: string, values?: unknown[]) => sql.includes('FROM "agent_executions"')
  ? { rows: [{ status: "running", attemptCount: owner.executionAttemptCount, state: {}, now: new Date() }] }
  : sql.includes('FROM "agent_turns"') ? { rows: [{ status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
    input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: { ...scheduledSnapshot, requireApproval } },
    leaseOwnerId: turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) }] }
    : sql.startsWith('UPDATE "agent_steps"') ? { rows: [{ id: scope.stepId }], rowCount: 1 }
      : sql.includes('DELETE FROM "agent_outbox"') ? { rows: [{ id: "dispatch-1" }], rowCount: 1 }
      : sql.includes('FROM "agent_items"') ? { rows: persistedQuestion ? [persistedQuestion] : [] }
        : { rows: [], rowCount: 1 }) }

describe("appendScheduledPrepare", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    client.query.mockClear()
    mocks.continuation.mockReturnValue(contract)
    mocks.claim.mockReturnValue(true)
    mocks.snapshot.mockReturnValue(true)
    mocks.analyze.mockReturnValue("analyst")
    mocks.replay.mockReturnValue(null)
    mocks.receiptMatches.mockReturnValue(true)
    mocks.readReceipt.mockResolvedValue(null)
    mocks.lock.mockResolvedValue(parent)
    mocks.load.mockResolvedValue(loaded)
    mocks.current.mockReturnValue(current)
    mocks.budget.mockResolvedValue(undefined)
    mocks.create.mockResolvedValue(scheduled)
    mocks.appendReceipt.mockResolvedValue(undefined)
    mocks.writePlanReceipt.mockResolvedValue(undefined)
    candidateStepStatus = "streaming"
    turnLeaseOwner = scope.turnLeaseOwner
    mocks.choiceBinding.mockResolvedValue({ binding: choiceBinding, receipt, waitId: choiceWaitId, stepId: "final-step",
      stepStatus: candidateStepStatus, candidateFinishReason: "stop", candidateUsage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } })
    mocks.choiceItem.mockReturnValue(null)
    mocks.enqueue.mockResolvedValue(undefined)
    requireApproval = true
    persistedQuestion = null
  })

  it("persists only the deterministic wait before an answer", async () => {
    await expect(appendScheduledPrepare(client as never, input)).resolves.toEqual({
      status: "waiting_for_choice", revision: 7, nodes: [], readyTaskIds: [],
      choice: { required: true, status: "waiting", waitId: choiceWaitId },
    })
    expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), contract.binding, contract.claimTokenDigest, expect.any(Date))
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.objectContaining({ source: "automation" }), `sha256:${"b".repeat(64)}`)
    expect(mocks.analyze).toHaveBeenCalledWith(input, loaded.snapshot, current, loaded.tasks, false)
    expect(mocks.budget).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.writePlanReceipt).not.toHaveBeenCalled()
    expect(mocks.appendReceipt).not.toHaveBeenCalled()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM "agent_outbox"'))).toBe(false)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.choiceBinding).toHaveBeenCalledWith(client, expect.objectContaining({ expectedReceipt: receipt }))
  })

  it("appends Prepare and its private receipt only after the exact answer exists", async () => {
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "keep_resume" } }
    mocks.choiceItem.mockReturnValue("keep_resume")
    await expect(appendScheduledPrepare(client as never, input)).resolves.toEqual({
      status: "accepted", revision: 8, nodes: scheduled.created, readyTaskIds: ["prepare-task"],
      choice: { required: true, status: "answered", waitId: choiceWaitId },
    })
    expect(mocks.budget).toHaveBeenCalledWith(client, expect.objectContaining({ turnId: owner.turnId }), 2)
    expect(mocks.create).toHaveBeenCalledWith(client, expect.objectContaining({ scope, proposal,
      templates: { prepare: expect.objectContaining({ role: expect.any(String) }) } }), parent, loaded.state, expect.any(Map), loaded)
    expect(mocks.writePlanReceipt).toHaveBeenCalledWith(client, expect.objectContaining({
      scope,
      state: scheduled.state,
      snapshot: scheduled.snapshot,
      expectedRevision: binding.analyzeGraphRevision,
      idempotencyKey: taskGraphProposalKey(scope.parentTaskId, binding.analyzeGraphRevision),
      fingerprint: contract.proposalFingerprint,
      receipt: { status: "accepted", revision: scheduled.state.revision, nodes: scheduled.created, readyTaskIds: ["prepare-task"] },
    }))
    expect(mocks.writePlanReceipt.mock.invocationCallOrder[0]).toBeLessThan(mocks.appendReceipt.mock.invocationCallOrder[0] ?? 0)
    expect(mocks.appendReceipt).toHaveBeenCalledWith(client, expect.objectContaining({ itemId: null, taskId: null,
      type: "agent.plan.scheduled_prepare_binding", idempotencyKey: `scheduled-prepare:${contract.proposalFingerprint}`,
      payload: receipt, actor: "system", outbox: false }))
    const dispatchSuppression = client.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM "agent_outbox"'))
    expect(dispatchSuppression?.[1]).toEqual([scope.sessionId, "subagent-dispatch:prepare-task"])
  })

  it("releases the exact ready Prepare task when the first append finds an already answered choice", async () => {
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "keep_resume" } }
    mocks.choiceItem.mockReturnValue("keep_resume")

    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({
      status: "accepted", choice: { required: true, status: "answered", waitId: choiceWaitId },
    })
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(mocks.enqueue).toHaveBeenCalledWith(client, scope.sessionId, { id: "prepare-task", rootTaskId: scope.rootTaskId })
    expect(mocks.appendReceipt.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0] ?? 0)
  })

  it("fails closed if a Prepare receipt exists before the exact choice answer", async () => {
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue({ status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] })

    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_receipt_conflict" })
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM "agent_outbox"'))).toBe(false)
  })

  it("releases only the exact Prepare task once on a replay with a validated answer", async () => {
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue({ status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] })
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "apply_ai_changes" } }
    mocks.choiceItem.mockReturnValue("apply_ai_changes")

    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({
      status: "duplicate", choice: { required: true, status: "answered", waitId: choiceWaitId },
    })
    expect(mocks.choiceItem).toHaveBeenCalledWith(persistedQuestion.content, "completed", choiceBinding)
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(mocks.enqueue).toHaveBeenCalledWith(client, scope.sessionId, { id: "prepare-task", rootTaskId: scope.rootTaskId })
  })

  it("resumes the exact answered candidate step before replaying after a process restart", async () => {
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue({ status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] })
    mocks.lock.mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    candidateStepStatus = "waiting_for_user"
    mocks.choiceBinding.mockResolvedValue({ binding: choiceBinding, receipt, waitId: choiceWaitId, stepId: "final-step",
      stepStatus: candidateStepStatus, candidateFinishReason: "stop", candidateUsage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } })
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "keep_resume" } }
    mocks.choiceItem.mockReturnValue("keep_resume")

    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({
      status: "duplicate", choice: { required: true, status: "answered", waitId: choiceWaitId },
    })
    const updateIndex = client.query.mock.calls.findIndex(([sql]) => sql.startsWith('UPDATE "agent_steps"'))
    const update = client.query.mock.calls[updateIndex]
    expect(update?.[0]).toContain('step."status" = \'waiting_for_user\'')
    expect(update?.[0]).toContain('turn."leaseExpiresAt" > clock_timestamp()')
    expect(update?.[0]).toContain('root."leaseExpiresAt" > clock_timestamp()')
    expect(update?.[0]).toContain('answer."content"->>\'answer\' = $12')
    expect(update?.[1]).toEqual([scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, scope.stepId,
      `agent-wait:question:${choiceWaitId}`, scope.turnLeaseOwner, scope.turnLeaseVersion, scope.parentLeaseOwner,
      scope.parentAttemptCount, choiceBinding.finalStepOrdinal, "keep_resume", expect.any(Date)])
    expect(mocks.lock).toHaveBeenCalledTimes(2)
    expect(client.query.mock.invocationCallOrder[updateIndex]).toBeLessThan(mocks.lock.mock.invocationCallOrder[1] ?? 0)
    expect(mocks.enqueue).toHaveBeenCalledWith(client, scope.sessionId, { id: "prepare-task", rootTaskId: scope.rootTaskId })
  })

  it("does not resume an unanswered scheduled choice", async () => {
    mocks.lock.mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    candidateStepStatus = "waiting_for_user"
    mocks.choiceBinding.mockResolvedValue({ binding: choiceBinding, receipt, waitId: choiceWaitId, stepId: "final-step",
      stepStatus: candidateStepStatus, candidateFinishReason: "stop", candidateUsage: null })

    await expect(appendScheduledPrepare(client as never, input)).rejects.toThrow("task_graph_step_fenced")
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_steps"'))).toBe(false)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("fails closed when the captured Turn owner or exact answer is stale", async () => {
    mocks.lock.mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    candidateStepStatus = "waiting_for_user"
    mocks.choiceBinding.mockResolvedValue({ binding: choiceBinding, receipt, waitId: choiceWaitId, stepId: "final-step",
      stepStatus: candidateStepStatus, candidateFinishReason: "stop", candidateUsage: null })
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "keep_resume" } }
    mocks.choiceItem.mockReturnValue("keep_resume")
    turnLeaseOwner = "stale-worker"
    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_choice_binding_stale" })
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_steps"'))).toBe(false)

    turnLeaseOwner = scope.turnLeaseOwner
    mocks.lock.mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    persistedQuestion = { ...persistedQuestion, stepId: "different-step" }
    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_choice_invalid" })
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_steps"'))).toBe(false)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("keeps same-owner answered command replay idempotent after the step resumes", async () => {
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue({ status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] })
    mocks.lock.mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    candidateStepStatus = "waiting_for_user"
    mocks.choiceBinding.mockResolvedValue({ binding: choiceBinding, receipt, waitId: choiceWaitId, stepId: "final-step",
      stepStatus: candidateStepStatus, candidateFinishReason: "stop", candidateUsage: null })
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "apply_ai_changes" } }
    mocks.choiceItem.mockReturnValue("apply_ai_changes")

    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({ status: "duplicate", choice: { status: "answered" } })
    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({ status: "duplicate", choice: { status: "answered" } })
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE "agent_steps"'))).toHaveLength(1)
    expect(mocks.enqueue).toHaveBeenNthCalledWith(1, client, scope.sessionId, { id: "prepare-task", rootTaskId: scope.rootTaskId })
    expect(mocks.enqueue).toHaveBeenNthCalledWith(2, client, scope.sessionId, { id: "prepare-task", rootTaskId: scope.rootTaskId })
  })

  it("keeps the immediate-dispatch path for a persisted snapshot without approval", async () => {
    requireApproval = false

    await expect(appendScheduledPrepare(client as never, input)).resolves.toMatchObject({
      status: "accepted", readyTaskIds: ["prepare-task"], choice: { required: false },
    })
    expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM "agent_outbox"'))).toBe(false)
    expect(mocks.choiceBinding).not.toHaveBeenCalled()
  })

  it("rejects malformed, closed, or stale scheduled choice evidence", async () => {
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue({ status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "queued" }], readyTaskIds: ["prepare-task"] })
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "failed", content: {} }
    mocks.choiceItem.mockReturnValue(undefined)
    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_choice_invalid" })
    expect(mocks.enqueue).not.toHaveBeenCalled()

    mocks.choiceBinding.mockRejectedValueOnce(new Error("stale scheduled candidate"))
    await expect(appendScheduledPrepare(client as never, input)).rejects.toThrow("stale scheduled candidate")
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("replays only the exact private receipt and matching existing Prepare node", async () => {
    const duplicate = { status: "duplicate", revision: 8, nodes: [{ key: "prepare", taskId: "prepare-task", status: "waiting" }], readyTaskIds: [] }
    mocks.readReceipt.mockResolvedValue(receipt)
    mocks.replay.mockReturnValue(duplicate)
    persistedQuestion = { id: `agent-wait:question:${choiceWaitId}`, stepId: "final-step", taskId: owner.rootTaskId,
      type: "question", status: "completed", content: { answer: "keep_resume" } }
    mocks.choiceItem.mockReturnValue("keep_resume")

    await expect(appendScheduledPrepare(client as never, input)).resolves.toEqual({
      ...duplicate, choice: { required: true, status: "answered", waitId: choiceWaitId },
    })
    expect(mocks.analyze).toHaveBeenCalledWith(input, loaded.snapshot, current, loaded.tasks, true)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.writePlanReceipt).not.toHaveBeenCalled()
    expect(mocks.appendReceipt).not.toHaveBeenCalled()

    mocks.receiptMatches.mockReturnValue(false)
    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_receipt_conflict" })
  })

  it("fails closed on a stale execution claim before reading or mutating the graph", async () => {
    mocks.claim.mockReturnValue(false)
    await expect(appendScheduledPrepare(client as never, input)).rejects.toMatchObject({ code: "scheduled_prepare_claim_stale" })
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.writePlanReceipt).not.toHaveBeenCalled()
    expect(mocks.appendReceipt).not.toHaveBeenCalled()
  })
})
