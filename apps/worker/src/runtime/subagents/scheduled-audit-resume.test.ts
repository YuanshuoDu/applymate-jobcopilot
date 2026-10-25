import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { DurableWaitResult } from "../tools/coordination-types.js"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID,
  scheduledAuditRegistrationReceiptKey,
  type ScheduledAuditResumeContext } from "./scheduled-audit-contract.js"
import type { ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { readScheduledAuditResumeContext, resumeScheduledAudit, scheduledAuditCompletionProofMatches } from "./scheduled-audit-resume.js"
const resumeContextMocks = vi.hoisted(() => ({ current: vi.fn(), load: vi.fn(), lock: vi.fn(), registration: vi.fn(), verifyGate: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ currentTaskGraph: resumeContextMocks.current,
  loadTaskGraph: resumeContextMocks.load, lockTaskGraphScope: resumeContextMocks.lock }))
vi.mock("./scheduled-audit-invocation.js", () => ({ readScheduledAuditRegistration: resumeContextMocks.registration,
  verifyRegisteredScheduledAuditGate: resumeContextMocks.verifyGate }))

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
    const deps = dependencies([context()])
    await expect(resumeScheduledAudit({ ...deps, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "completed" })
    expect(deps.wait).not.toHaveBeenCalled()
    expect(deps.verifyScheduledAuditCompletion).toHaveBeenCalledWith({ scope, executionOwner: context().executionOwner,
      gateProof, auditTaskId: "audit-1", attemptCount: 1 })
  })

  it("waits on the exact registered Audit task and attempt, then rereads before verification", async () => {
    const deps = dependencies([context("queued"), context()])
    await expect(resumeScheduledAudit({ ...deps, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "completed" })
    const key = `scheduled-audit-wait:${createHash("sha256").update(JSON.stringify(["audit-1", "final-step", 1]), "utf8").digest("hex")}`
    expect(deps.wait).toHaveBeenCalledWith({ userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: "final-step", taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, targetTaskIds: ["audit-1"], mode: "all",
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
    await expect(resumeScheduledAudit({ command, waitPort: { wait }, scope, finalStepId: "final-step",
      signal: new AbortController().signal } as never)).resolves.toEqual({ status: "completed" })
    expect(command.reads).toBe(2)
    expect(command.verifications).toBe(1)
  })

  it("rejects a ready wake for another child before reading completion proof", async () => {
    const deps = dependencies([context("queued")], { wait: { waitId: "wrong", status: "ready",
      deadlineAt: "2026-10-25T10:00:00.000Z", matchedTaskIds: ["gate-1"] } })
    await expect(resumeScheduledAudit({ ...deps, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_wait_invalid" })
    expect(deps.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("blocks if the registered Audit binding changes while the root waits", async () => {
    const changed = { ...context(), auditTaskId: "audit-2" } as ScheduledAuditResumeContext
    const deps = dependencies([context("queued"), changed])
    await expect(resumeScheduledAudit({ ...deps, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_wait_binding_changed" })
    expect(deps.verifyScheduledAuditCompletion).not.toHaveBeenCalled()
  })

  it("distinguishes a missing Audit registration from an invalid completion proof", async () => {
    const missing = dependencies([{ status: "not_registered" }])
    await expect(resumeScheduledAudit({ ...missing, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "not_registered" })
    const invalid = dependencies([context()], { proof: null })
    await expect(resumeScheduledAudit({ ...invalid, scope, finalStepId: "final-step", signal: new AbortController().signal } as never))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_completion_unverified" })
  })

  it("does not return completed if cancellation arrives during database proof verification", async () => {
    const controller = new AbortController(), cancelled = new Error("cancelled")
    const command = { async readScheduledAuditResumeContext() { return context() },
      async verifyScheduledAuditCompletion() { controller.abort(cancelled); return completionProof } }
    await expect(resumeScheduledAudit({ command, waitPort: { wait: vi.fn() }, scope, finalStepId: "final-step",
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
      { key: "scout" }, { key: "analyst" }, { key: "prepare" }, { key: "gate" },
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
