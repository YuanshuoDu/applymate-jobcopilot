import { createHash } from "node:crypto"
import type { DurableWaitPort, DurableWaitResult } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "./task-graph-command-port.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope, type GraphIdentityScope } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { readScheduledAuditRegistration, verifyRegisteredScheduledAuditGate } from "./scheduled-audit-invocation.js"
import {
  SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE,
  SCHEDULED_AUDIT_TEMPLATE_ID, parseScheduledAuditRegistrationReceipt, scheduledAuditRegistrationReceiptKey,
  parseScheduledAuditReport, SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA,
  type ScheduledAuditCompletionProof, type ScheduledAuditResumeContext, type TaskGraphScheduledAuditResumeInput,
} from "./scheduled-audit-contract.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
type ResumeCommand = Pick<TaskGraphCommandPort, "readScheduledAuditResumeContext" | "verifyScheduledAuditCompletion">

export async function readScheduledAuditResumeContext(client: Queryable,
  input: TaskGraphScheduledAuditResumeInput): Promise<ScheduledAuditResumeContext> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const scope: GraphIdentityScope = { userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.rootTaskId }
  const loaded = await loadTaskGraph(client, scope, true), nodes = loaded.snapshot?.nodes
  if (!loaded.item || !loaded.snapshot || !loaded.state || !nodes) return { status: "invalid" }
  const audits = nodes.filter(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (audits.length === 0) {
    if (nodes.length < 2 || nodes.length > 4) return { status: "invalid" }
    return await hasOrphanAuditRegistration(client, scope, input.scope.parentAttemptCount)
      ? { status: "invalid" } : { status: "not_registered" }
  }
  const node = audits.length === 1 ? audits[0] : undefined
  const task = node && loaded.tasks.get(node.taskId), current = currentTaskGraph(loaded)
    .nodes.find(candidate => candidate.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (!node || nodes.length !== 5 || nodes[4] !== node || node.templateId !== SCHEDULED_AUDIT_TEMPLATE_ID
    || node.depth !== 5 || node.verificationDisposition !== "specialized" || node.goal !== SCHEDULED_AUDIT_NODE_GOAL
    || !same(node.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA) || !same(node.dependsOn, ["gate"])
    || !task || !current || current.taskId !== node.taskId || current.status !== task.status
    || task.role !== SCHEDULED_AUDIT_ROLE || task.taskType !== SCHEDULED_AUDIT_TASK_TYPE
    || !same(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true
    || !["queued", "retrying", "running", "completed"].includes(task.status)
    || !Number.isSafeInteger(task.attemptCount) || task.attemptCount! < 0
    || task.status === "completed" && (task.attemptCount! < 1 || task.failureReason !== null || current.failureReason !== null)) return { status: "invalid" }
  const registration = await readScheduledAuditRegistration(client, scope, node.taskId)
  if (!registration || registration.auditTaskId !== node.taskId || registration.owner.rootAttemptCount !== input.scope.parentAttemptCount
    || registration.owner.userId !== input.scope.userId || registration.owner.sessionId !== input.scope.sessionId
    || registration.owner.turnId !== input.scope.turnId || registration.owner.rootTaskId !== input.scope.rootTaskId) return { status: "invalid" }
  const gateProof = await verifyRegisteredScheduledAuditGate(client, scope, loaded, registration)
  const expectedAttemptCount = task.status === "queued" || task.status === "retrying" ? task.attemptCount! + 1 : task.attemptCount!
  if (!gateProof || !Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 1) return { status: "invalid" }
  return { status: "registered", auditTaskId: node.taskId, auditStatus: task.status as "queued" | "retrying" | "running" | "completed",
    expectedAttemptCount, owner: registration.owner, executionOwner: { executionId: registration.owner.executionId,
      executionAttemptCount: registration.owner.executionAttemptCount }, snapshotDigest: registration.snapshotDigest, gateProof }
}

async function hasOrphanAuditRegistration(client: Queryable, scope: GraphIdentityScope, rootAttemptCount: number): Promise<boolean> {
  const result = await client.query(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND session."userId" = $4 AND turn."userId" = $4`, [scope.sessionId, scope.turnId,
    SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, scope.userId])
  return result.rows.some(raw => {
    const row = record(raw), receipt = parseScheduledAuditRegistrationReceipt(row?.payload)
    if (!row || !receipt || row.itemId !== null || row.taskId !== null || row.actor !== "system" || row.hasOutbox !== false
      || row.idempotencyKey !== scheduledAuditRegistrationReceiptKey(receipt.continuationKey, receipt.auditTaskId)
      || receipt.owner.userId !== scope.userId || receipt.owner.sessionId !== scope.sessionId
      || receipt.owner.turnId !== scope.turnId || receipt.owner.rootTaskId !== scope.rootTaskId) return true
    return receipt.owner.rootAttemptCount >= rootAttemptCount
  })
}

export async function resumeScheduledAudit(input: Readonly<{ command: ResumeCommand; waitPort: Pick<DurableWaitPort, "wait">;
  scope: TaskGraphReadScope; finalStepId: string; signal: AbortSignal }>): Promise<
  | Readonly<{ status: "not_registered" | "completed" }>
  | Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "blocked"; errorCode: string }>> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
  const command = input.command
  if (!command.readScheduledAuditResumeContext || !command.verifyScheduledAuditCompletion) {
    return { status: "blocked", errorCode: "scheduled_audit_resume_unavailable" }
  }
  let context = await command.readScheduledAuditResumeContext({ scope: input.scope })
  if (context.status === "not_registered") return { status: "not_registered" }
  if (context.status !== "registered") return { status: "blocked", errorCode: "scheduled_audit_resume_invalid" }
  if (context.auditStatus !== "completed") {
    const initialContext = context
    const wait = await input.waitPort.wait({ userId: input.scope.userId, sessionId: input.scope.sessionId,
      turnId: input.scope.turnId, stepId: input.finalStepId, taskId: input.scope.rootTaskId, rootTaskId: input.scope.rootTaskId,
      targetTaskIds: [context.auditTaskId], mode: "all", timeoutMs: WAIT_TIMEOUT_MS,
      idempotencyKey: scheduledAuditWaitKey(context.auditTaskId, input.finalStepId, context.expectedAttemptCount) })
    if (!validScheduledAuditWait(wait, context.auditTaskId)) return { status: "blocked", errorCode: "scheduled_audit_wait_invalid" }
    if (wait.status === "waiting") return { status: "waiting_for_dependency", waitId: wait.waitId }
    if (wait.status !== "ready") return { status: "blocked", errorCode: `scheduled_audit_wait_${wait.status}` }
    if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
    context = await command.readScheduledAuditResumeContext({ scope: input.scope })
    if (context.status !== "registered" || context.auditStatus !== "completed") {
      return { status: "blocked", errorCode: "scheduled_audit_wait_state_invalid" }
    }
    if (context.auditTaskId !== initialContext.auditTaskId || context.expectedAttemptCount !== initialContext.expectedAttemptCount
      || !same(context.owner, initialContext.owner) || context.snapshotDigest !== initialContext.snapshotDigest
      || !same(context.gateProof, initialContext.gateProof)) {
      return { status: "blocked", errorCode: "scheduled_audit_wait_binding_changed" }
    }
  }
  const proof = await command.verifyScheduledAuditCompletion({ scope: input.scope, executionOwner: context.executionOwner, gateProof: context.gateProof,
    auditTaskId: context.auditTaskId, attemptCount: context.expectedAttemptCount })
  if (input.signal.aborted) throw input.signal.reason ?? new Error("scheduled_audit_resume_cancelled")
  return scheduledAuditCompletionProofMatches(proof, { owner: context.owner, snapshotDigest: context.snapshotDigest,
    gateProof: context.gateProof, auditTaskId: context.auditTaskId, attemptCount: context.expectedAttemptCount })
    ? { status: "completed" } : { status: "blocked", errorCode: "scheduled_audit_completion_unverified" }
}

export function scheduledAuditCompletionProofMatches(value: ScheduledAuditCompletionProof | null, expected: Readonly<{
  owner: ScheduledAuditCompletionProof["owner"]
  snapshotDigest: string
  gateProof: ScheduledAuditCompletionProof["gateProof"]
  auditTaskId: string
  attemptCount: number
}>): boolean {
  try {
    const owner = value?.owner, audit = value?.audit
    return Boolean(value && value.schemaVersion === SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA
      && Object.keys(value).sort().join(",") === "audit,gateProof,graphRevision,owner,report,schemaVersion,snapshotDigest"
      && owner && same(owner, expected.owner)
      && value.snapshotDigest === expected.snapshotDigest && same(value.gateProof, expected.gateProof)
      && Number.isSafeInteger(value.graphRevision) && value.graphRevision > expected.gateProof.graphRevision
      && audit && Object.keys(audit).sort().join(",") === "attemptCount,completedEventRevision,resultDigest,taskId"
      && audit.taskId === expected.auditTaskId && audit.attemptCount === expected.attemptCount
      && typeof audit.resultDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(audit.resultDigest)
      && Number.isSafeInteger(audit.completedEventRevision) && audit.completedEventRevision! > 0
      && audit.completedEventRevision! <= value.graphRevision && parseScheduledAuditReport(value.report))
  } catch { return false }
}

export function scheduledAuditWaitKey(taskId: string, stepId: string, attemptCount: number): string {
  const digest = createHash("sha256").update(JSON.stringify([taskId, stepId, attemptCount]), "utf8").digest("hex")
  return `scheduled-audit-wait:${digest}`
}
export function validScheduledAuditWait(value: DurableWaitResult, taskId: string): boolean {
  try {
    const row = record(value), matched = row?.matchedTaskIds
    return !!row && validId(row.waitId) && Array.isArray(matched)
      && ["waiting", "ready", "timed_out", "interrupted", "closed"].includes(String(row.status))
      && (row.status === "ready" ? matched.length === 1 && matched[0] === taskId
        : row.status === "waiting" ? matched.length === 0 : true)
  } catch { return false }
}
function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
