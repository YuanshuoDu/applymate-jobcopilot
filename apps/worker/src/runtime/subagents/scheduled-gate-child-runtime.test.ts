import { afterEach, describe, expect, it, vi } from "vitest"
import { scheduledGateCandidateSetDigest, SCHEDULED_GATE_OUTPUT_SCHEMA } from "./scheduled-gate-contract.js"
import { parseScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.js"
import type { ScheduledPipelineGateResponse } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { ScheduledGateChoiceHistory } from "./pg-scheduled-task-graph-gate-choices.js"
import type { SubagentLease } from "./types.js"

const handoff = vi.hoisted(() => ({ post: vi.fn(async (_input: unknown, _signal: AbortSignal, _fetcher?: typeof fetch): Promise<ScheduledPipelineGateResponse> => ({
  status: "blocked", errorCode: "fixture_default",
})) }))
const loader = vi.hoisted(() => ({ checkpoint: vi.fn(), graph: vi.fn(), current: vi.fn(), snapshotMatches: vi.fn(), analyzeMatches: vi.fn(),
  registration: vi.fn(), prepareProof: vi.fn(), discovery: vi.fn(), roleResult: vi.fn(), report: vi.fn() }))
vi.mock("./scheduled-pipeline-handoff.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-pipeline-handoff.js")>(),
  postScheduledPipelineGate: handoff.post,
}))
vi.mock("./scheduled-gate-contract.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-contract.js")>(), scheduledGateCheckpointEvidence: loader.checkpoint,
}))
vi.mock("./task-graph-pg-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-state.js")>(), loadTaskGraph: loader.graph, currentTaskGraph: loader.current,
}))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>(),
  scheduledSnapshotMatches: loader.snapshotMatches, scheduledAnalyzeGraphMatches: loader.analyzeMatches,
}))
vi.mock("./scheduled-gate-registration-receipt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-registration-receipt.js")>(), readScheduledGateRegistrationReceipt: loader.registration,
}))
vi.mock("./scheduled-gate-wait-match.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-wait-match.js")>(), loadPersistedScheduledPrepareProof: loader.prepareProof,
}))
vi.mock("./child-discovery-attempt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./child-discovery-attempt.js")>(), parseDiscoveryAttemptSidecar: loader.discovery,
}))
vi.mock("./role-results.js", async importOriginal => ({
  ...await importOriginal<typeof import("./role-results.js")>(), validateRoleResult: loader.roleResult,
}))
vi.mock("./task-graph-verification-report.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-verification-report.js")>(), parseStoredTaskGraphVerificationReport: loader.report,
}))

const owner: ScheduledAutomationPipelineBridgeScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "root-worker-old", turnLeaseVersion: 9,
}
const digest = `sha256:${"a".repeat(64)}`
const attestation: ScheduledAutomationPipelineAttestation = {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner, snapshotDigest: digest, graphRevision: 4,
  scout: { taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest,
    candidateJobIds: ["job-a"], discoveryReceipt: { status: "complete", taskId: "scout-1", attemptCount: 1,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest } },
  analyst: { taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest,
    dependsOnTaskIds: ["scout-1"], jobIds: ["job-a"] }, evidenceDigest: digest,
}
const prepareProof = { result: { jobs: [{ jobId: "job-a", status: "prepared" }] }, completion: { wait: { waitId: "prepare-wait-1" } } } as unknown as ScheduledPrepareTaskGraphProof
const invocation = { owner, attestation, prepareProof }
const choices: ScheduledGateChoiceHistory = {
  validatedChoice: { kind: "weak_cover_letter", jobIds: ["job-a"], choiceId: "review" },
  priorChoices: [{ kind: "borderline_match", jobIds: ["job-a"], choiceId: "add_to_pending" }],
}

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "gate-task-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, path: "/root-1/gate-1", depth: 1,
    role: "prepare", taskType: "scheduled_taskgraph_gate", status: "running", goal: "Review prepared applications",
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA,
    modelProfileSnapshot: null, result: null, failureReason: null, attemptCount: 3, maxAttempts: 3, leaseOwner: "worker-gate-1",
    leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
    ownerId: "worker-gate-1", signal: new AbortController().signal,
    ...overrides,
  }
}

const completed = {
  status: "completed" as const, nextStage: "execute" as const, approvedJobIds: [], pendingJobIds: ["job-a"], skippedJobIds: [],
  counts: { approved: 0, pending: 1, skipped: 0 },
}
const question = {
  status: "question_required" as const, kind: "weak_cover_letter" as const, jobIds: ["job-a"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-a"]),
  allowedChoiceIds: ["continue", "review", "skip"] as const,
}

const NO_WAIT = Symbol("no persisted root question wait")

function productionLoaderFixture(waitId: unknown = "agent-question:turn-1:canonical:root-wait", requireApproval = true) {
  const handoffKey = `scheduled-taskgraph:sha256:${"f".repeat(64)}`
  const storedOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: "expired-root-worker", turnLeaseVersion: 9,
    executionId: "execution-1", executionAttemptCount: 5 }
  const checkpoint = { ...(waitId === NO_WAIT ? {} : { scheduledTaskGraphScheduledWaitId: waitId }),
    scheduledTaskGraphClaim: { claimToken: "claim-token" },
    scheduledTaskGraphContinuation: { key: handoffKey, owner: storedOwner } }
  const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
    targetLocations: ["Dublin"], minScore: 70, dailyCap: 2, requireApproval, autoApply: false }
  const evidence = { owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, executionId: "execution-1", executionAttemptCount: 5 },
    continuationKey: `scheduled-taskgraph:sha256:${"b".repeat(64)}`, snapshotDigest: digest, evidenceDigest: "c".repeat(64),
    checkpointDigest: "d".repeat(64), analyzeGraphRevision: 4, prepareWaitContinuationKey: handoffKey }
  const registration = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1", owner: evidence.owner,
    continuationKey: evidence.continuationKey, snapshotDigest: evidence.snapshotDigest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: evidence.analyzeGraphRevision,
    prepareScheduleRevision: 5, prepareWaitId: "prepare-dependency-wait", gateTaskId: "gate-task-1", gateAppendRevision: 6 }
  const prepare = { receipt: { owner: storedOwner, continuationKey: evidence.continuationKey, snapshotDigest: evidence.snapshotDigest,
      evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 4, prepareScheduleRevision: 5 },
    completion: { wait: { waitId: registration.prepareWaitId }, nodes: [{}, {}, { taskId: "prepare-task" }] },
    result: { jobs: [{ jobId: "job-a", status: "prepared" }] } }
  const scoutResult = { status: "completed", role: "scout", candidates: [{ jobId: "job-a" }] }
  const analystResult = { status: "completed", role: "analyst", findings: [{ jobId: "job-a" }] }
  const envelope = (structuredResult: unknown, discoveryAttempt?: unknown) => ({ finalItemId: null, finalText: "", status: "completed",
    stepCount: 1, toolCallCount: 1, taskGraphVerificationReport: {}, structuredResult, ...(discoveryAttempt ? { discoveryAttempt } : {}) })
  const nodes = [
    { key: "scout", taskId: "scout-task", templateId: "scout", depth: 1, dependsOn: [], verification: { criteria: [{ id: "scout" }] } },
    { key: "analyst", taskId: "analyst-task", templateId: "analyst", depth: 2, dependsOn: ["scout"], verification: { criteria: [{ id: "analyst" }] } },
    { key: "prepare", taskId: "prepare-task", templateId: "prepare", depth: 3, goal: "Prepare", successCriteria: [], dependsOn: ["analyst"] },
    { key: "gate", taskId: "gate-task-1", templateId: "gate", depth: 4, verificationDisposition: "specialized", dependsOn: ["prepare"] },
  ]
  const tasks = new Map([
    ["scout-task", { id: "scout-task", status: "completed", role: "scout", attemptCount: 1, result: envelope(scoutResult, {}) }],
    ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", attemptCount: 1, result: envelope(analystResult) }],
    ["prepare-task", { id: "prepare-task", status: "completed", role: "prepare", attemptCount: 1, result: null }],
    ["gate-task-1", { id: "gate-task-1", status: "running", role: "prepare", attemptCount: 3, result: null }],
  ])
  loader.checkpoint.mockReturnValue(evidence)
  loader.snapshotMatches.mockReturnValue(true)
  loader.graph.mockResolvedValue({ snapshot: { nodes }, state: { nodes: [{ key: "gate", status: "running" }] }, tasks })
  loader.current.mockReturnValue({ revision: 8, nodes: nodes.map(node => ({ key: node.key, status: "completed" })) })
  loader.registration.mockResolvedValue(registration)
  loader.prepareProof.mockResolvedValue(prepare)
  loader.analyzeMatches.mockReturnValue("analyst")
  loader.roleResult.mockImplementation((_value: unknown, role: string) => role === "scout" ? scoutResult : analystResult)
  loader.report.mockReturnValue({ status: "passed", resultDigest: "e".repeat(64) })
  loader.discovery.mockReturnValue({ attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
    candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false })
  const live = { id: "gate-task-1", role: "prepare", taskType: "scheduled_taskgraph_gate", status: "running", attemptCount: 3,
    leaseOwner: "worker-gate-1", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
    expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], rootAttemptCount: owner.rootAttemptCount,
    rootStatus: "waiting_for_tool", rootInterruptRequestedAt: null, source: "automation", executionMode: "canonical_task_graph",
    turnInput: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot }, turnStatus: "waiting_for_tool", turnRootTaskId: owner.rootTaskId,
    userId: owner.userId, sessionStatus: "active", executionId: "execution-1", executionAttemptCount: 5,
    executionStatus: "waiting_for_user", state: checkpoint }
  const client = { query: vi.fn(async (sql: string) => {
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql) || sql.includes("set_config('app.user_id'")) return { rows: [] }
    if (sql.includes('FROM "sub_agent_tasks" AS gate')) return { rows: [live] }
    if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [{ stepId: "prepare-step" }] }
    throw new Error(`unexpected fixed Gate loader query: ${sql}`)
  }), release: vi.fn() }
  return { pool: { connect: async () => client }, client, storedOwner, registration, evidence, handoffKey }
}

afterEach(() => {
  handoff.post.mockClear()
  for (const mock of Object.values(loader)) mock.mockReset()
})

describe("fixed scheduled Gate child runtime", () => {
  it("sends the current child fence and private validated choices without substituting the Prepare dependency wait", async () => {
    handoff.post.mockResolvedValue(completed)
    const executor = createScheduledGateChildExecutor({
      pool: {} as never,
      loadInvocation: async () => invocation,
      loadChoices: async () => choices,
    })
    const task = lease()
    await expect(executor({ lease: task })).resolves.toEqual({
      status: "completed",
      result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
        taskGraphVerificationReport: null, structuredResult: completed },
    })
    expect(handoff.post).toHaveBeenCalledOnce()
    expect(handoff.post.mock.calls[0]?.[0]).toEqual({
      owner, attestation, prepareProof, gateTaskId: task.id,
      gateLeaseOwnerId: task.ownerId, gateAttemptCount: task.attemptCount,
      validatedChoice: choices.validatedChoice, priorChoices: choices.priorChoices,
    })
    expect(handoff.post.mock.calls[0]?.[0]).not.toHaveProperty("scheduledWaitId")
    expect(handoff.post.mock.calls[0]?.[0]).toMatchObject({ gateLeaseOwnerId: task.ownerId, gateAttemptCount: task.attemptCount })
    expect(task.ownerId).not.toBe(owner.turnLeaseOwnerId)
  })

  it("persists a typed question as waiting_for_user and does not treat it as completion", async () => {
    handoff.post.mockResolvedValue(question)
    const executor = createScheduledGateChildExecutor({ pool: {} as never,
      loadInvocation: async () => invocation, loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    await expect(executor({ lease: lease() })).resolves.toEqual({
      status: "waiting_for_user",
      result: { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
        taskGraphVerificationReport: null, structuredResult: question },
    })
  })

  it("loads the production checkpoint after a suspended Root wait and forwards its root wait, not the Prepare dependency wait", async () => {
    const { pool, client, storedOwner, registration, evidence, handoffKey } = productionLoaderFixture()
    expect(parseScheduledGateRegistrationReceipt(registration)).toEqual(registration)
    handoff.post.mockResolvedValue(completed)
    const executor = createScheduledGateChildExecutor({ pool: pool as never,
      loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({ status: "completed" })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FROM "sub_agent_tasks" AS gate'), expect.any(Array))
    expect(registration.prepareWaitId).not.toBe("agent-question:turn-1:canonical:root-wait")
    expect(handoff.post.mock.calls[0]?.[0]).toMatchObject({
      scheduledWaitId: "agent-question:turn-1:canonical:root-wait", gateLeaseOwnerId: "worker-gate-1", gateAttemptCount: 3,
    })
    expect(evidence.continuationKey).not.toBe(handoffKey)
    expect(loader.prepareProof).toHaveBeenCalledWith(expect.anything(), expect.anything(), "prepare-task", null,
      handoffKey, registration.prepareWaitId)
    const analyzeInput = loader.analyzeMatches.mock.calls[0]?.[0] as { handoff: { continuationKey: string } }
    expect(analyzeInput.handoff.continuationKey).toBe(handoffKey)
    expect(analyzeInput.handoff.continuationKey).not.toBe(evidence.continuationKey)
    expect(handoff.post.mock.calls[0]?.[0]).toHaveProperty("prepareProof.receipt.owner.turnLeaseOwnerId", storedOwner.turnLeaseOwnerId)
  })

  it("rejects a mismatched recovered Prepare-wait handoff key before Web dispatch", async () => {
    const fixture = productionLoaderFixture()
    const wrongKey = `scheduled-taskgraph:sha256:${"e".repeat(64)}`
    loader.checkpoint.mockReturnValue({ ...fixture.evidence, prepareWaitContinuationKey: wrongKey })
    loader.analyzeMatches.mockImplementation((candidate: unknown) => {
      const input = candidate as { handoff?: { continuationKey?: unknown } }
      return input.handoff?.continuationKey === fixture.handoffKey ? "analyst" : null
    })
    const executor = createScheduledGateChildExecutor({ pool: fixture.pool as never,
      loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({
      status: "failed", failureReason: "scheduled_gate_analyze_proof_invalid", retryDisposition: "terminal",
    })
    expect(handoff.post).not.toHaveBeenCalled()
    expect(loader.prepareProof).toHaveBeenCalledWith(expect.anything(), expect.anything(), "prepare-task", null,
      wrongKey, fixture.registration.prepareWaitId)
  })

  it("rejects malformed persisted root wait identity while preserving absence when approval is disabled", async () => {
    const malformed = productionLoaderFixture(null)
    const executor = createScheduledGateChildExecutor({ pool: malformed.pool as never,
      loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({
      status: "failed", failureReason: "scheduled_gate_checkpoint_invalid", retryDisposition: "terminal",
    })
    expect(handoff.post).not.toHaveBeenCalled()

    const absent = productionLoaderFixture(NO_WAIT, false)
    handoff.post.mockResolvedValue(completed)
    const noApprovalExecutor = createScheduledGateChildExecutor({ pool: absent.pool as never,
      loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    const noApprovalResult = await noApprovalExecutor({ lease: lease() })
    expect(noApprovalResult).toMatchObject({ status: "completed" })
    expect(handoff.post.mock.calls[0]?.[0]).not.toHaveProperty("scheduledWaitId")
  })

  it("rejects a non-fixed lease before reading lineage or calling Web", async () => {
    const loadInvocation = vi.fn(async () => invocation)
    const executor = createScheduledGateChildExecutor({ pool: {} as never, loadInvocation })
    await expect(executor({ lease: lease({ allowedActions: ["browser.click"] }) })).resolves.toEqual({
      status: "failed", failureReason: "scheduled_gate_task_invalid", retryDisposition: "terminal",
    })
    expect(loadInvocation).not.toHaveBeenCalled()
    expect(handoff.post).not.toHaveBeenCalled()
  })

  it("keeps owner/proof blocks terminal and transient handoff failures retryable", async () => {
    const executor = createScheduledGateChildExecutor({ pool: {} as never,
      loadInvocation: async () => invocation, loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
    handoff.post.mockResolvedValue({ status: "blocked", errorCode: "scheduled_pipeline_gate_task_stale" })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({ status: "failed", retryDisposition: "terminal" })
    handoff.post.mockRejectedValue(new Error("scheduled_pipeline_handoff_retryable"))
    await expect(executor({ lease: lease() })).resolves.toEqual({
      status: "failed", failureReason: "scheduled_gate_handoff_retryable", retryDisposition: "retryable",
    })
  })
})
