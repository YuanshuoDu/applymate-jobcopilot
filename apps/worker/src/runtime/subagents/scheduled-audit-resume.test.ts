import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DurableWaitResult } from "../tools/coordination-types.js"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID,
  scheduledAuditRegistrationReceiptKey,
  type ScheduledAuditResumeContext } from "./scheduled-audit-contract.js"
import type { ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID, scheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT, SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA,
  scheduledGateRegistrationReceiptKey } from "./scheduled-gate-registration-receipt.js"
import { readScheduledAuditResumeContext, resumeScheduledAudit, scheduledAuditCompletionProofMatches } from "./scheduled-audit-resume.js"
const resumeContextMocks = vi.hoisted(() => ({ current: vi.fn(), load: vi.fn(), lock: vi.fn(), registration: vi.fn(), verifyGate: vi.fn(),
  prepareProof: vi.fn(), preparePrefix: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ currentTaskGraph: resumeContextMocks.current,
  loadTaskGraph: resumeContextMocks.load, lockTaskGraphScope: resumeContextMocks.lock }))
vi.mock("./scheduled-audit-invocation.js", () => ({ readScheduledAuditRegistration: resumeContextMocks.registration,
  verifyRegisteredScheduledAuditGate: resumeContextMocks.verifyGate }))
vi.mock("./scheduled-gate-wait-match.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-wait-match.js")>(),
  loadPersistedScheduledPrepareProof: resumeContextMocks.prepareProof }))
vi.mock("./pg-scheduled-task-graph-gate-verification.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-scheduled-task-graph-gate-verification.js")>(),
  verifyPersistedScheduledPreparePrefix: resumeContextMocks.preparePrefix }))

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 4 }
const gateProof = ({ schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 18,
  prepareProof: { receipt: { continuationKey: "continuation-1" }, completion: { graphRevision: 17, nodes: ["scout", "prepare"] } },
  gate: { taskId: "gate-1", attemptCount: 2, resultDigest: `sha256:${"a".repeat(64)}`, completedEventRevision: 18 } }) as unknown as ScheduledGateCompletionProof
const snapshotDigest = `sha256:${"b".repeat(64)}`
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, parentAttemptCount: owner.rootAttemptCount }
const context = (auditStatus: "queued" | "completed" = "completed"): ScheduledAuditResumeContext => ({
  status: "registered", auditTaskId: "audit-1", auditStatus, expectedAttemptCount: 1, owner,
  executionOwner: { executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }, snapshotDigest, gateProof,
})
const report = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 4 }
const completionProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-audit-completion.v1", owner, snapshotDigest,
  graphRevision: 20, gateProof,
  audit: { taskId: "audit-1", attemptCount: 1, resultDigest: `sha256:${"c".repeat(64)}`, completedEventRevision: 19 }, report }

function gateContinuationFixture(options: Readonly<{ requireApproval?: boolean; scheduledWaitId?: string; executionId?: string;
  registrationRootTaskId?: string; currentLeaseOwner?: string; currentLeaseVersion?: number;
  checkpointLeaseOwner?: string; checkpointLeaseVersion?: number; claimLeaseOwner?: string; claimLeaseVersion?: number }> = {}) {
  const requireApproval = options.requireApproval ?? true
  const turnLeaseOwnerId = options.currentLeaseOwner ?? "turn-owner", turnLeaseVersion = options.currentLeaseVersion ?? 4
  const checkpointLeaseOwner = options.checkpointLeaseOwner ?? turnLeaseOwnerId
  const checkpointLeaseVersion = options.checkpointLeaseVersion ?? turnLeaseVersion
  const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
    targetLocations: ["Dublin"], minScore: 70, dailyCap: 2, requireApproval, autoApply: false }
  const gateSnapshotDigest = `sha256:${createHash("sha256").update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles,
    snapshot.targetLocations, snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), "utf8").digest("hex")}`
  const gateEvidenceOwner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: checkpointLeaseOwner, turnLeaseVersion: checkpointLeaseVersion,
    executionId: options.executionId ?? owner.executionId,
    executionAttemptCount: owner.executionAttemptCount }
  const claimOwner = { ...gateEvidenceOwner, turnLeaseOwnerId: options.claimLeaseOwner ?? checkpointLeaseOwner,
    turnLeaseVersion: options.claimLeaseVersion ?? checkpointLeaseVersion }
  const rawContinuationKey = `scheduled-taskgraph:sha256:${"b".repeat(64)}`
  const executionState = { nextStage: "gate", analysisFailed: 0,
    scoutedJobs: [{ id: "job-1", userId: scope.userId }],
    scoredJobs: [{ job: { id: "job-1", userId: scope.userId }, score: 80, matchedKeywords: [], missingKeywords: [], recommendation: "Eligible" }],
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
      key: rawContinuationKey, owner: gateEvidenceOwner, snapshotDigest: gateSnapshotDigest, graphRevision: 4, evidenceDigest: "e".repeat(64) },
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: rawContinuationKey,
      claimToken: "claim-token", owner: claimOwner, claimedAt: "2026-10-25T09:00:00.000Z", leaseExpiresAt: "2026-10-25T11:00:00.000Z" },
    ...(options.scheduledWaitId === undefined ? {} : { scheduledTaskGraphScheduledWaitId: options.scheduledWaitId }) }
  const evidence = scheduledGateCheckpointEvidence(executionState)
  if (!evidence) throw new Error("invalid Gate checkpoint fixture")
  const gateOwner = evidence.owner
  const registration = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1",
    owner: { ...gateOwner, rootTaskId: options.registrationRootTaskId ?? gateOwner.rootTaskId },
    continuationKey: evidence.continuationKey, snapshotDigest: gateSnapshotDigest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 4, prepareScheduleRevision: 5,
    prepareWaitId: "prepare-wait-1", gateTaskId: "gate-1", gateAppendRevision: 6 }
  const prepareProof = { receipt: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1",
    owner: gateEvidenceOwner, continuationKey: evidence.continuationKey, snapshotDigest: gateSnapshotDigest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 4, prepareScheduleRevision: 5 },
    completion: { graphRevision: 5, wait: { waitId: registration.prepareWaitId }, nodes: [{}, {}, { taskId: "prepare-1" }] },
    result: { jobs: [{ jobId: "job-1", status: "prepared" }] } }
  const nodes = [
    { key: "scout", taskId: "scout-1", templateId: "scout", depth: 1, verificationDisposition: "typed", verification: { role: "scout", criteria: [{ id: "scout" }] }, dependsOn: [] },
    { key: "analyst", taskId: "analyst-1", templateId: "analyst", depth: 2, verificationDisposition: "typed", verification: { role: "analyst", criteria: [{ id: "analyst" }] }, dependsOn: ["scout"] },
    { key: "prepare", taskId: "prepare-1", templateId: "prepare", depth: 3, verificationDisposition: "specialized", dependsOn: ["analyst"] },
    { key: SCHEDULED_GATE_TEMPLATE_ID, taskId: "gate-1", templateId: SCHEDULED_GATE_TEMPLATE_ID, depth: 4,
      verificationDisposition: "specialized", goal: SCHEDULED_GATE_NODE_GOAL,
      successCriteria: SCHEDULED_GATE_NODE_CRITERIA, dependsOn: ["prepare"] },
  ]
  const currentNodes = nodes.map(node => ({ key: node.key, taskId: node.taskId,
    status: node.key === SCHEDULED_GATE_TEMPLATE_ID ? "running" : "completed", failureReason: null }))
  const gateTask = { id: "gate-1", status: "running", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
    expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], contextIsEmpty: true, attemptCount: 2, failureReason: null }
  const tasks = new Map<string, unknown>([
    ["scout-1", { id: "scout-1", status: "completed", role: "scout", attemptCount: 1 }],
    ["analyst-1", { id: "analyst-1", status: "completed", role: "analyst", attemptCount: 1 }],
    ["prepare-1", { id: "prepare-1", status: "completed", role: "prepare", attemptCount: 1,
      result: { taskGraphScheduledPrepareProofFacts: { receipt: prepareProof.receipt,
        completion: { graphRevision: prepareProof.completion.graphRevision, nodes: prepareProof.completion.nodes },
        result: prepareProof.result } } }],
    ["gate-1", gateTask],
  ])
  const appliedEvents = [{ nodeKey: SCHEDULED_GATE_TEMPLATE_ID, type: "task.started",
    idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, 1, "task.started"), expectedRevision: 6 }]
  const loaded = { item: { id: "graph-item" }, snapshot: { nodes }, state: { revision: 8, appliedEvents }, tasks }
  resumeContextMocks.load.mockResolvedValue(loaded as never)
  resumeContextMocks.current.mockReturnValue({ revision: 8, nodes: currentNodes })
  resumeContextMocks.prepareProof.mockResolvedValue(prepareProof)
  resumeContextMocks.preparePrefix.mockResolvedValue(true)
  const execution = { id: owner.executionId, status: "running", attemptCount: owner.executionAttemptCount,
    state: executionState, now: new Date("2026-10-25T10:00:00.000Z") }
  const turn = { source: "automation", executionMode: "canonical_task_graph",
    input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } }
  const gateReceiptRow = { itemId: null, taskId: null, actor: "system",
    idempotencyKey: scheduledGateRegistrationReceiptKey(registration.continuationKey, registration.gateTaskId),
    payload: registration, hasOutbox: false }
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => sql.includes('FROM "agent_executions"') ? { rows: [execution] }
    : sql.includes('FROM "agent_turns"') ? { rows: [turn] }
      : sql.includes('FROM "agent_events"') && values?.[2] === SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT
        ? { rows: [gateReceiptRow] } : { rows: [] })
  const readScope = { ...scope, turnLeaseOwner: turnLeaseOwnerId, turnLeaseVersion, parentLeaseOwner: "root-owner" }
  return { query, readScope, evidence, registration, prepareProof, executionState }
}

beforeEach(() => {
  for (const mock of [resumeContextMocks.current, resumeContextMocks.load, resumeContextMocks.lock, resumeContextMocks.registration,
    resumeContextMocks.verifyGate, resumeContextMocks.prepareProof, resumeContextMocks.preparePrefix]) mock.mockReset()
})

function dependencies(contexts: ScheduledAuditResumeContext[], overrides: Readonly<{ wait?: DurableWaitResult; proof?: unknown }> = {}) {
  const readScheduledAuditResumeContext = vi.fn(async () => contexts.shift() ?? context())
  const verifyScheduledAuditCompletion = vi.fn(async () => overrides.proof === undefined ? completionProof : overrides.proof)
  const wait = vi.fn(async () => overrides.wait ?? ({ waitId: "audit-wait", status: "ready" as const,
    deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["audit-1"] }))
  return { command: { readScheduledAuditResumeContext, verifyScheduledAuditCompletion }, waitPort: { wait },
    readScheduledAuditResumeContext, verifyScheduledAuditCompletion, wait }
}

describe("scheduled Audit root resume", () => {
  it("verifies a completed Audit against its registered owner and Gate proof", async () => {
    const completedContext = context()
    if (completedContext.status !== "registered") throw new Error("expected a registered Audit context")
    const deps = dependencies([completedContext])
    await expect(resumeScheduledAudit({ ...deps, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "completed" })
    expect(deps.wait).not.toHaveBeenCalled()
    expect(deps.verifyScheduledAuditCompletion).toHaveBeenCalledWith({ scope, executionOwner: completedContext.executionOwner,
      gateProof, auditTaskId: "audit-1", attemptCount: 1 })
  })

  it("waits on the exact registered Audit task and attempt under the active recovery step", async () => {
    const deps = dependencies([context("queued"), context()])
    await expect(resumeScheduledAudit({ ...deps, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "completed" })
    const key = `scheduled-audit-wait:${createHash("sha256").update(JSON.stringify(["audit-1", "recovery-step", 1]), "utf8").digest("hex")}`
    expect(deps.wait).toHaveBeenCalledWith({ userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: "recovery-step", taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, targetTaskIds: ["audit-1"], mode: "all",
      timeoutMs: 24 * 60 * 60 * 1_000, idempotencyKey: key })
    expect(deps.readScheduledAuditResumeContext).toHaveBeenCalledTimes(2)
    expect(deps.verifyScheduledAuditCompletion).toHaveBeenCalledOnce()
  })

  it("accepts the same Audit binding after a ready wake and preserves command receiver methods", async () => {
    class ReceiverCommand {
      reads = 0
      verifications = 0
      private contexts = [context("queued"), context()]
      async readScheduledAuditResumeContext() { this.reads += 1; return this.contexts.shift() ?? context() }
      async verifyScheduledAuditCompletion() { this.verifications += 1; return completionProof }
    }
    const command = new ReceiverCommand(), wait = vi.fn(async () => ({ waitId: "audit-wait", status: "ready" as const,
      deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["audit-1"] }))
    await expect(resumeScheduledAudit({ command, waitPort: { wait }, scope, recoveryStepId: "recovery-step",
      signal: new AbortController().signal } as never)).resolves.toEqual({ status: "completed" })
    expect(command.reads).toBe(2)
    expect(command.verifications).toBe(1)
  })

  it("rejects a ready wake for another child before reading completion proof", async () => {
    const deps = dependencies([context("queued")], { wait: { waitId: "wrong", status: "ready",
      deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["gate-1"] } })
    await expect(resumeScheduledAudit({ ...deps, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_wait_invalid" })
    expect(deps.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("blocks if the registered Audit binding changes while the root waits", async () => {
    const changed = { ...context(), auditTaskId: "audit-2" } as ScheduledAuditResumeContext
    const deps = dependencies([context("queued"), changed])
    await expect(resumeScheduledAudit({ ...deps, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_wait_binding_changed" })
    expect(deps.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("distinguishes a missing Audit registration from an invalid completion proof", async () => {
    const missing = dependencies([{ status: "not_registered" }])
    await expect(resumeScheduledAudit({ ...missing, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "not_registered" })
    const invalid = dependencies([context()], { proof: null })
    await expect(resumeScheduledAudit({ ...invalid, scope, recoveryStepId: "recovery-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_completion_unverified" })
  })

  it("does not return completed if cancellation arrives during database proof verification", async () => {
    const controller = new AbortController(), cancelled = new Error("cancelled")
    const command = { async readScheduledAuditResumeContext() { return context() },
      async verifyScheduledAuditCompletion() { controller.abort(cancelled); return completionProof } }
    await expect(resumeScheduledAudit({ command, waitPort: { wait: vi.fn() }, scope, recoveryStepId: "recovery-step",
      signal: controller.signal } as never)).rejects.toBe(cancelled)
  })

  it("accepts retry-queued Audit rows that retain their prior failure reason", async () => {
    const failureReason = "scheduled_audit_handoff_retryable"
    const auditNode = { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID,
      taskId: "audit-1", depth: 5, verificationDisposition: "specialized", goal: SCHEDULED_AUDIT_NODE_GOAL,
      successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ["gate"] }
    const tasks = new Map([["audit-1", { id: "audit-1", status: "queued", failureReason, role: SCHEDULED_AUDIT_ROLE,
      taskType: SCHEDULED_AUDIT_TASK_TYPE, expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA,
      allowedActions: [], contextIsEmpty: true, attemptCount: 1 }]])
    resumeContextMocks.load.mockResolvedValue({ item: { id: "graph-item" }, snapshot: { nodes: [
      { key: "scout" }, { key: "analyst" }, { key: "prepare" }, { key: "gate" }, auditNode,
    ] }, state: { revision: 19 }, tasks })
    resumeContextMocks.current.mockReturnValue({ nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID,
      taskId: "audit-1", status: "queued", failureReason }] })
    resumeContextMocks.registration.mockResolvedValue({ auditTaskId: "audit-1", owner,
      snapshotDigest, expectedAttemptCount: 1 })
    resumeContextMocks.verifyGate.mockResolvedValue(gateProof)
    const readScope = { ...scope, turnLeaseOwner: "turn-owner", turnLeaseVersion: 4, parentLeaseOwner: "root-owner" }
    await expect(readScheduledAuditResumeContext({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as never,
      { scope: readScope } as never)).resolves.toMatchObject({ status: "registered", auditTaskId: "audit-1",
      auditStatus: "queued", expectedAttemptCount: 2 })
  })

  it("does not report genuine absence when the current root owner has an orphan Audit receipt", async () => {
    const continuationKey = `scheduled-taskgraph:sha256:${"a".repeat(64)}`
    const receipt = { schemaVersion: SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA, owner, continuationKey,
      snapshotDigest, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7,
      prepareScheduleRevision: 8, prepareWaitId: "prepare-wait", gateTaskId: "gate-1", gateAttemptCount: 1,
      gateResultDigest: `sha256:${"e".repeat(64)}`, gateCompletedEventRevision: 12,
      gateProofDigest: `sha256:${"f".repeat(64)}`, scheduledWaitId: null, auditTaskId: "audit-1",
      gateGraphRevision: 12, auditAppendRevision: 13, expectedAttemptCount: 1 }
    resumeContextMocks.load.mockResolvedValue({ item: { id: "graph-item" }, snapshot: { nodes: [
      { key: "scout" }, { key: "analyst" }, { key: "prepare" },
    ] }, state: { revision: 12 }, tasks: new Map() })
    const readScope = { ...scope, turnLeaseOwner: "turn-owner", turnLeaseVersion: 4, parentLeaseOwner: "root-owner" }
    const noReceiptQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await expect(readScheduledAuditResumeContext({ query: noReceiptQuery } as never, { scope: readScope } as never))
      .resolves.toEqual({ status: "not_registered" })
    const query = vi.fn(async (sql: string) => sql.includes("set_config")
      ? { rows: [], rowCount: 1 }
      : { rows: [{ itemId: null, taskId: null, actor: "system",
        idempotencyKey: scheduledAuditRegistrationReceiptKey(continuationKey, "audit-1"), payload: receipt, hasOutbox: false }], rowCount: 1 })
    await expect(readScheduledAuditResumeContext({ query } as never, { scope: readScope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining(`event."type" = $3`),
      [scope.sessionId, scope.turnId, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, scope.userId])
  })

  it("reconstructs the exact registered four-node Gate continuation and canonical choice wait", async () => {
    const fixture = gateContinuationFixture({ scheduledWaitId: "agent-question:turn-1:canonical:root-wait" })
    const result = await readScheduledAuditResumeContext({ query: fixture.query } as never, { scope: fixture.readScope } as never)
    expect(result).toEqual({ status: "gate_continuation", handoff: {
      status: "analyze_checkpointed", continuationKey: fixture.evidence.prepareWaitContinuationKey,
      checkpointDigest: fixture.evidence.checkpointDigest,
      claimTokenDigest: `sha256:${createHash("sha256").update("claim-token").digest("hex")}`,
      executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount,
    }, prepareProof: fixture.prepareProof, scheduledWaitId: "agent-question:turn-1:canonical:root-wait" })
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining('event."type" = $3'),
      [scope.sessionId, scope.turnId, SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT, scope.userId])
    expect(resumeContextMocks.prepareProof).toHaveBeenCalledWith(expect.anything(), fixture.readScope, "prepare-1",
      expect.anything(), fixture.evidence.prepareWaitContinuationKey, fixture.registration.prepareWaitId)
    expect(resumeContextMocks.preparePrefix).toHaveBeenCalledOnce()
  })

  it("rejects foreign owner, mismatched Prepare proof, and an unverified prefix in a four-node graph", async () => {
    const foreign = gateContinuationFixture({ executionId: "execution-foreign" })
    await expect(readScheduledAuditResumeContext({ query: foreign.query } as never, { scope: foreign.readScope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(resumeContextMocks.prepareProof).not.toHaveBeenCalled()

    const foreignReceipt = gateContinuationFixture({ registrationRootTaskId: "root-foreign" })
    await expect(readScheduledAuditResumeContext({ query: foreignReceipt.query } as never, { scope: foreignReceipt.readScope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(resumeContextMocks.prepareProof).not.toHaveBeenCalled()

    const mismatchedProof = gateContinuationFixture()
    resumeContextMocks.prepareProof.mockResolvedValue({ ...mismatchedProof.prepareProof,
      receipt: { ...mismatchedProof.prepareProof.receipt, checkpointDigest: "f".repeat(64) } })
    await expect(readScheduledAuditResumeContext({ query: mismatchedProof.query } as never, { scope: mismatchedProof.readScope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(resumeContextMocks.preparePrefix).not.toHaveBeenCalled()

    const staleProof = gateContinuationFixture({ scheduledWaitId: "agent-question:turn-1:canonical:root-wait" })
    resumeContextMocks.preparePrefix.mockResolvedValue(false)
    await expect(readScheduledAuditResumeContext({ query: staleProof.query } as never, { scope: staleProof.readScope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(resumeContextMocks.preparePrefix).toHaveBeenCalledOnce()
  })

  it("binds the claim to checkpoint lease A while the root lock independently fences renewed lease B", async () => {
    const mismatch = gateContinuationFixture({ scheduledWaitId: "agent-question:turn-1:canonical:root-wait",
      currentLeaseOwner: "root-live", currentLeaseVersion: 2, checkpointLeaseOwner: "checkpoint-owner-a", checkpointLeaseVersion: 1,
      claimLeaseOwner: "claim-owner-c", claimLeaseVersion: 3 })
    await expect(readScheduledAuditResumeContext({ query: mismatch.query } as never, { scope: mismatch.readScope } as never))
      .resolves.toEqual({ status: "invalid" })

    const renewed = gateContinuationFixture({ scheduledWaitId: "agent-question:turn-1:canonical:root-wait",
      currentLeaseOwner: "root-live", currentLeaseVersion: 2, checkpointLeaseOwner: "checkpoint-owner-a", checkpointLeaseVersion: 1,
      claimLeaseOwner: "checkpoint-owner-a", claimLeaseVersion: 1 })
    await expect(readScheduledAuditResumeContext({ query: renewed.query } as never, { scope: renewed.readScope } as never))
      .resolves.toMatchObject({ status: "gate_continuation", handoff: { executionId: owner.executionId } })
    expect(resumeContextMocks.lock).toHaveBeenCalledWith({ query: renewed.query }, renewed.readScope)
  })

  it("rejects absent or foreign-turn canonical waits when approval is required", async () => {
    const missing = gateContinuationFixture()
    await expect(readScheduledAuditResumeContext({ query: missing.query } as never, { scope: missing.readScope } as never))
      .resolves.toEqual({ status: "invalid" })

    const foreignWait = gateContinuationFixture({ scheduledWaitId: "agent-question:turn-2:canonical:root-wait" })
    await expect(readScheduledAuditResumeContext({ query: foreignWait.query } as never, { scope: foreignWait.readScope } as never))
      .resolves.toEqual({ status: "invalid" })
  })

  it("accepts an approval-disabled four-node Gate prefix without an optional wait id", async () => {
    const fixture = gateContinuationFixture({ requireApproval: false })
    const result = await readScheduledAuditResumeContext({ query: fixture.query } as never, { scope: fixture.readScope } as never)
    expect(result).toMatchObject({ status: "gate_continuation", handoff: { executionId: owner.executionId } })
    expect(result).not.toHaveProperty("scheduledWaitId")
  })

  it("accepts reordered proof object keys but rejects changed owner, task attempt, or Gate content", () => {
    const reordered = { report, snapshotDigest, owner: { ...owner }, audit: { ...completionProof.audit },
      gateProof: { gate: { ...gateProof.gate }, prepareProof: gateProof.prepareProof,
        graphRevision: gateProof.graphRevision, schemaVersion: gateProof.schemaVersion },
      graphRevision: completionProof.graphRevision, schemaVersion: completionProof.schemaVersion }
    const expected = { owner, snapshotDigest, gateProof, auditTaskId: "audit-1", attemptCount: 1 }
    expect(scheduledAuditCompletionProofMatches(reordered as never, expected)).toBe(true)
    expect(scheduledAuditCompletionProofMatches({ ...completionProof, owner: { ...owner, executionAttemptCount: 5 } } as never, expected)).toBe(false)
    expect(scheduledAuditCompletionProofMatches({ ...completionProof,
      audit: { ...completionProof.audit, attemptCount: 2 } } as never, expected)).toBe(false)
    expect(scheduledAuditCompletionProofMatches({ ...completionProof,
      gateProof: { ...gateProof, gate: { ...gateProof.gate, resultDigest: `sha256:${"d".repeat(64)}` } } } as never, expected)).toBe(false)
    const reversed = { ...gateProof, prepareProof: { receipt: { continuationKey: "continuation-1" },
      completion: { graphRevision: 17, nodes: ["prepare", "scout"] } } }
    expect(scheduledAuditCompletionProofMatches({ ...completionProof, gateProof: reversed } as never, expected)).toBe(false)
  })
})
