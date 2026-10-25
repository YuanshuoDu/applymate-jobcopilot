import { afterEach, describe, expect, it, vi } from "vitest"
import { taskGraphVerificationRole } from "../planning/task-graph-verification.js"
import { createScheduledAuditChildExecutor, isScheduledAuditCandidate, isScheduledAuditLease } from "./scheduled-audit-child-runtime.js"
import { SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA, SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_ROLE,
  SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import type { SubagentLease } from "./types.js"

const mocks = vi.hoisted(() => ({
  post: vi.fn(), current: vi.fn(), loadGraph: vi.fn(), evidence: vi.fn(), preparedIds: vi.fn(), registration: vi.fn(),
  prepareProof: vi.fn(), snapshotMatches: vi.fn(), parseSnapshot: vi.fn(), parseHealth: vi.fn(), validateRole: vi.fn(),
  parseReport: vi.fn(), createCommand: vi.fn(), readInvocation: vi.fn(),
}))
vi.mock("./scheduled-pipeline-handoff.js", async importOriginal => ({ ...await importOriginal<typeof import("./scheduled-pipeline-handoff.js")>(),
  postScheduledPipelineExecute: mocks.post }))
vi.mock("./task-graph-pg-state.js", () => ({ currentTaskGraph: mocks.current, loadTaskGraph: mocks.loadGraph }))
vi.mock("./scheduled-gate-contract.js", async importOriginal => ({ ...await importOriginal<typeof import("./scheduled-gate-contract.js")>(),
  scheduledGateCheckpointEvidence: mocks.evidence, scheduledGatePreparedJobIds: mocks.preparedIds }))
vi.mock("./scheduled-gate-registration-receipt.js", () => ({ readScheduledGateRegistrationReceipt: mocks.registration }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ loadPersistedScheduledPrepareProof: mocks.prepareProof }))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", () => ({ scheduledSnapshotMatches: mocks.snapshotMatches }))
vi.mock("./child-discovery-attempt.js", () => ({ parseDiscoveryAttemptSidecar: mocks.parseHealth }))
vi.mock("./role-results.js", async importOriginal => ({ ...await importOriginal<typeof import("./role-results.js")>(),
  validateRoleResult: mocks.validateRole }))
vi.mock("./task-graph-verification-report.js", () => ({ parseStoredTaskGraphVerificationReport: mocks.parseReport }))
vi.mock("./scheduled-automation-snapshot.js", () => ({ parseScheduledAutomationSnapshot: mocks.parseSnapshot }))
vi.mock("./pg-task-graph-command-port.js", () => ({ createPgTaskGraphCommandPort: mocks.createCommand }))

const digest = `sha256:${"a".repeat(64)}`
const owner = { userId: "user-audit", sessionId: "session-audit", turnId: "turn-audit", rootTaskId: "root-audit", rootAttemptCount: 1,
  turnLeaseOwnerId: "root-lease", turnLeaseVersion: 2, executionId: "execution-audit", executionAttemptCount: 1 }
const pipelineOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
const stableOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
const evidence = { owner, continuationKey: `scheduled-taskgraph:sha256:${"b".repeat(64)}`, snapshotDigest: digest,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 2, prepareWaitContinuationKey: "prepare-key" }
const prepareProof = { receipt: { owner, continuationKey: evidence.continuationKey, snapshotDigest: digest,
  evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 2, prepareScheduleRevision: 3 },
  completion: { wait: { waitId: "prepare-wait" }, nodes: [{}, {}, { taskId: "prepare-task" }] }, result: { jobs: [{ jobId: "job-a", status: "prepared" }] } }
const gateProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 5,
  prepareProof, gate: { taskId: "gate-task", attemptCount: 1, resultDigest: "gate-digest", completedEventRevision: 5 } }
const report = { processed: 2, applied: 0, queued: 0, pending: 1, skipped: 1, failed: 0, durationMs: 9 }

function setup() {
  const registration = { continuationKey: evidence.continuationKey, snapshotDigest: digest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 2, prepareScheduleRevision: 3, prepareWaitId: "prepare-wait" }
  const scout = { status: "completed", role: "scout", candidates: [{ jobId: "job-a" }] }
  const analyst = { status: "completed", role: "analyst", findings: [{ jobId: "job-a" }] }
  const envelope = (structuredResult: unknown, discoveryAttempt?: unknown) => ({ finalItemId: null, finalText: "", status: "completed",
    stepCount: 1, toolCallCount: 1, taskGraphVerificationReport: {}, structuredResult, ...(discoveryAttempt ? { discoveryAttempt } : {}) })
  const nodes = [
    { key: "scout", taskId: "scout-task", templateId: "scout", verification: { role: "scout", criteria: [{ id: "scout" }] } },
    { key: "analyst", taskId: "analyst-task", templateId: "analyst", verification: { role: "analyst", criteria: [{ id: "analyst" }] } },
    { key: "prepare", taskId: "prepare-task", templateId: "prepare" },
    { key: "gate", taskId: "gate-task", templateId: "gate", verificationDisposition: "specialized", dependsOn: ["prepare"] },
    { key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: "audit-task", templateId: SCHEDULED_AUDIT_TEMPLATE_ID, depth: 5,
      verificationDisposition: "legacy_unverified", dependsOn: ["gate"] },
  ]
  const tasks = new Map<string, unknown>([
    ["scout-task", { id: "scout-task", status: "completed", role: "scout", attemptCount: 1, result: envelope(scout, {}) }],
    ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", attemptCount: 1, result: envelope(analyst) }],
    ["prepare-task", { id: "prepare-task", status: "completed", role: "prepare", attemptCount: 1, result: null }],
    ["gate-task", { id: "gate-task", status: "completed", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
      attemptCount: 1, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], result: null }],
    ["audit-task", { id: "audit-task", status: "running", role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
      attemptCount: 4, expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, allowedActions: [], result: null }],
  ])
  mocks.evidence.mockReturnValue(evidence)
  mocks.snapshotMatches.mockReturnValue(true)
  mocks.parseSnapshot.mockReturnValue({})
  mocks.current.mockReturnValue({ revision: 6, nodes: nodes.map(node => ({ key: node.key, status: node.key === SCHEDULED_AUDIT_TEMPLATE_ID ? "running" : "completed" })) })
  mocks.loadGraph.mockResolvedValue({ snapshot: { nodes }, state: { nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, status: "running" }] }, tasks })
  mocks.registration.mockResolvedValue(registration)
  mocks.prepareProof.mockResolvedValue(prepareProof)
  mocks.preparedIds.mockReturnValue(["job-a"])
  mocks.parseHealth.mockReturnValue({ attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
    candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false })
  mocks.validateRole.mockImplementation((_value: unknown, role: string) => role === "scout" ? scout : analyst)
  mocks.parseReport.mockReturnValue({ status: "passed", resultDigest: "verified-digest", evidenceDigest: "verified-evidence" })
  mocks.readInvocation.mockImplementation(async (input: { attestation: unknown }) => ({ schemaVersion: SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA,
    owner: stableOwner, snapshotDigest: digest, attestation: input.attestation, prepareProof, gateProof,
    scheduledWaitId: null, auditTaskId: "audit-task", attemptCount: 4, graphRevision: 6 }))
  mocks.createCommand.mockReturnValue({ readScheduledAuditInvocationProof: mocks.readInvocation })
  const live = { id: "audit-task", role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE, status: "running", attemptCount: 4,
    leaseOwner: "worker-audit", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
    expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, allowedActions: [], rootAttemptCount: 1,
    rootStatus: "waiting_for_dependency", rootInterruptRequestedAt: null, source: "automation", executionMode: "canonical_task_graph",
    turnInput: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, turnStatus: "waiting_for_dependency",
    turnRootTaskId: owner.rootTaskId, userId: owner.userId, sessionStatus: "active", executionId: owner.executionId,
    executionAttemptCount: 1, executionStatus: "waiting_for_user", state: {} }
  const client = { query: vi.fn(async (sql: string) => {
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql) || sql.includes("set_config('app.user_id'")) return { rows: [] }
    if (sql.includes('FROM "sub_agent_tasks" AS audit')) return { rows: [live] }
    throw new Error(`unexpected Audit runtime query: ${sql}`)
  }), release: vi.fn() }
  mocks.post.mockResolvedValue({ status: "completed", report })
  return { client, pool: { connect: vi.fn(async () => client) }, nodes, live }
}

afterEach(() => { vi.resetAllMocks() })

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return { id: "audit-task", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    parentTaskId: owner.rootTaskId, path: "/root/audit", depth: 1, role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
    status: "running", goal: "Audit the exact scheduled report", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, modelProfileSnapshot: null, result: null, failureReason: null,
    attemptCount: 4, maxAttempts: 4, leaseOwner: "worker-audit", leaseExpiresAt: new Date(Date.now() + 60_000),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-audit", signal: new AbortController().signal,
    ...overrides }
}

describe("fixed scheduled Audit child runtime", () => {
  it("rebinds the current Audit lease and private Gate proof before returning only the exact report", async () => {
    const fixture = setup(), task = lease(), executor = createScheduledAuditChildExecutor({ pool: fixture.pool as never,
      fetcher: vi.fn(async () => new Response()) })
    await expect(executor({ lease: task })).resolves.toEqual({ status: "completed", result: {
      finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: report,
    } })
    expect(fixture.client.release).toHaveBeenCalledOnce()
    expect(mocks.readInvocation).toHaveBeenCalledWith({ scope: { userId: owner.userId, sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId }, auditTaskId: task.id, attemptCount: task.attemptCount,
      attestation: expect.objectContaining({ owner: pipelineOwner, graphRevision: 2 }) })
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ owner: pipelineOwner, prepareProof,
      gateCompletionProof: gateProof }), task.signal, expect.any(Function))
  })

  it.each([
    { extra: 1 }, { processed: -1 }, { applied: 0.5 }, { queued: Number.MAX_SAFE_INTEGER + 1 },
  ])("fails closed for a non-exact or unsafe report", async invalid => {
    const fixture = setup()
    mocks.post.mockResolvedValue({ status: "completed", report: { ...report, ...invalid } })
    const result = await createScheduledAuditChildExecutor({ pool: fixture.pool as never })({ lease: lease() })
    expect(result).toMatchObject({ status: "failed", failureReason: "scheduled_audit_report_invalid", retryDisposition: "terminal" })
  })

  it("does not complete on a missing invocation proof or unsupported wait", async () => {
    const missing = setup()
    mocks.readInvocation.mockResolvedValue(null)
    await expect(createScheduledAuditChildExecutor({ pool: missing.pool as never })({ lease: lease() })).resolves.toMatchObject({
      status: "failed", failureReason: "scheduled_audit_runtime_failed", retryDisposition: "terminal",
    })
    const waiting = setup()
    mocks.post.mockResolvedValue({ status: "waiting_for_user", waitId: "external-wait" })
    await expect(createScheduledAuditChildExecutor({ pool: waiting.pool as never })({ lease: lease() })).resolves.toMatchObject({
      status: "failed", failureReason: "scheduled_audit_wait_unsupported", retryDisposition: "terminal",
    })
  })

  it("replays only the exact persisted report when the execution is already completed", async () => {
    const fixture = setup()
    fixture.live.executionStatus = "completed"
    await expect(createScheduledAuditChildExecutor({ pool: fixture.pool as never })({ lease: lease() })).resolves.toEqual({
      status: "completed", result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
        taskGraphVerificationReport: null, structuredResult: report },
    })
    expect(mocks.post).toHaveBeenCalledOnce()
  })

  it("reserves legacy_unverified for the private Audit proof path, never the generic verifier", async () => {
    const fixture = setup()
    expect(fixture.nodes[4]?.verificationDisposition).toBe("legacy_unverified")
    expect(taskGraphVerificationRole(SCHEDULED_AUDIT_TEMPLATE_ID)).toBeUndefined()
    expect(isScheduledAuditCandidate({ role: SCHEDULED_AUDIT_ROLE, taskType: "other" })).toBe(false)
    expect(isScheduledAuditLease(lease())).toBe(true)
    expect(isScheduledAuditLease(lease({ role: "prepare" }))).toBe(false)
    expect(isScheduledAuditLease(lease({ allowedActions: ["jobs.discover"] }))).toBe(false)
  })

  it("routes only the scheduled Audit task type and rejects a mismatched role", async () => {
    const generic = lease({ role: SCHEDULED_AUDIT_ROLE, taskType: "native_verification" })
    expect(isScheduledAuditCandidate(generic)).toBe(false)

    const scheduledWithWrongRole = lease({ role: "analyst", taskType: SCHEDULED_AUDIT_TASK_TYPE })
    expect(isScheduledAuditCandidate(scheduledWithWrongRole)).toBe(true)
    const fixture = setup()
    await expect(createScheduledAuditChildExecutor({ pool: fixture.pool as never })({ lease: scheduledWithWrongRole })).resolves.toEqual({
      status: "failed", failureReason: "scheduled_audit_task_invalid", retryDisposition: "terminal",
    })
    expect(fixture.pool.connect).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
