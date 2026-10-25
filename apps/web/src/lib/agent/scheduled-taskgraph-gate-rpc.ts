import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import type { ScheduledTaskGraphAuditActor } from "./scheduled-taskgraph-audit-child-fence"

export type ScheduledTaskGraphGateRequestOwner = Pick<ScheduledTaskGraphPipelineOwner,
  "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount" | "turnLeaseOwnerId" | "turnLeaseVersion">
export type ScheduledTaskGraphGateRpcRequest = Readonly<{
  action: "gate"
  owner: ScheduledTaskGraphGateRequestOwner
  attestation: unknown
  prepareProof: unknown
  scheduledWaitId?: string
  gateTaskId: string
  gateLeaseOwnerId: string
  gateAttemptCount: number
  validatedChoice?: unknown
  priorChoices?: readonly unknown[]
}>
export type ScheduledTaskGraphExecuteRpcRequest = Readonly<{
  action: "execute"
  owner: ScheduledTaskGraphGateRequestOwner
  attestation: unknown
  prepareProof: unknown
  scheduledWaitId?: string
  gateCompletionProof: unknown
}>
export type ScheduledTaskGraphAuditExecuteRpcRequest = Readonly<{
  action: "scheduled_audit_execute"
  owner: ScheduledTaskGraphGateRequestOwner
  attestation: unknown
  prepareProof: unknown
  scheduledWaitId?: string
  gateCompletionProof: unknown
  auditActor: ScheduledTaskGraphAuditActor
}>
export type ScheduledTaskGraphLegacyRpcRequest = Readonly<{
  action: "legacy"
  owner: ScheduledTaskGraphGateRequestOwner
  attestation: unknown
  prepareProof?: unknown
  scheduledWaitId?: string
}>
export type ScheduledTaskGraphActionRequest = ScheduledTaskGraphGateRpcRequest | ScheduledTaskGraphExecuteRpcRequest
  | ScheduledTaskGraphAuditExecuteRpcRequest | ScheduledTaskGraphLegacyRpcRequest

const ROLE_RESULT_SCHEMA = "agent-harness.v2.subagent.result"
const GATE_TASK_TYPE = "scheduled_taskgraph_gate"
const GATE_SCHEMA = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", taskType: GATE_TASK_TYPE }
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"]
const GATE_KEYS = ["action", "attestation", "gateAttemptCount", "gateLeaseOwnerId", "gateTaskId", "owner", "prepareProof"]
const GATE_OPTIONAL_KEYS = ["priorChoices", "scheduledWaitId", "validatedChoice"]
const EXECUTE_KEYS = ["action", "attestation", "gateCompletionProof", "owner", "prepareProof"]
const EXECUTE_OPTIONAL_KEYS = ["scheduledWaitId"]
const AUDIT_EXECUTE_KEYS = ["action", "attestation", "auditActor", "gateCompletionProof", "owner", "prepareProof"]
const AUDIT_EXECUTE_OPTIONAL_KEYS = ["scheduledWaitId"]
const LEGACY_OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"]

/** Parses the fixed Worker action envelope; snapshots, jobs and claim tokens are always reloaded by Web. */
export function parseScheduledTaskGraphActionRequest(value: unknown): ScheduledTaskGraphActionRequest | null {
  const row = record(value)
  if (!row) return null
  if (row.action === undefined) return parseLegacyRequest(row)
  if (!plainObject(row.owner) || !exactKeys(row.owner, OWNER_KEYS)
    || ![row.owner.userId, row.owner.sessionId, row.owner.turnId, row.owner.rootTaskId, row.owner.turnLeaseOwnerId].every(validId)
    || !positive(row.owner.rootAttemptCount) || !positive(row.owner.turnLeaseVersion)
    || !Object.hasOwn(row, "attestation") || !Object.hasOwn(row, "prepareProof")) return null
  if (row.action === "gate") {
    if (!onlyKeys(row, GATE_KEYS, GATE_OPTIONAL_KEYS) || !validId(row.gateTaskId) || !validId(row.gateLeaseOwnerId)
      || !positive(row.gateAttemptCount) || Object.hasOwn(row, "scheduledWaitId") && !validId(row.scheduledWaitId)
      || Object.hasOwn(row, "priorChoices") && (!Array.isArray(row.priorChoices) || row.priorChoices.length > 51)) return null
    return { action: "gate", owner: row.owner as unknown as ScheduledTaskGraphGateRequestOwner, attestation: row.attestation,
      prepareProof: row.prepareProof, gateTaskId: row.gateTaskId, gateLeaseOwnerId: row.gateLeaseOwnerId,
      gateAttemptCount: Number(row.gateAttemptCount), ...(Object.hasOwn(row, "scheduledWaitId") ? { scheduledWaitId: row.scheduledWaitId as string } : {}),
      ...(Object.hasOwn(row, "validatedChoice") && row.validatedChoice !== null ? { validatedChoice: row.validatedChoice } : {}),
      ...(Object.hasOwn(row, "priorChoices") ? { priorChoices: row.priorChoices as unknown[] } : {}) }
  }
  if (row.action === "execute") {
    if (!onlyKeys(row, EXECUTE_KEYS, EXECUTE_OPTIONAL_KEYS) || !Object.hasOwn(row, "gateCompletionProof")
      || Object.hasOwn(row, "scheduledWaitId") && !validId(row.scheduledWaitId)) return null
    return { action: "execute", owner: row.owner as unknown as ScheduledTaskGraphGateRequestOwner, attestation: row.attestation,
      prepareProof: row.prepareProof, gateCompletionProof: row.gateCompletionProof,
      ...(Object.hasOwn(row, "scheduledWaitId") ? { scheduledWaitId: row.scheduledWaitId as string } : {}) }
  }
  if (row.action === "scheduled_audit_execute") {
    if (!onlyKeys(row, AUDIT_EXECUTE_KEYS, AUDIT_EXECUTE_OPTIONAL_KEYS) || !Object.hasOwn(row, "gateCompletionProof")
      || Object.hasOwn(row, "scheduledWaitId") && !validId(row.scheduledWaitId) || !validAuditActor(row.auditActor)) return null
    return { action: "scheduled_audit_execute", owner: row.owner as unknown as ScheduledTaskGraphGateRequestOwner,
      attestation: row.attestation, prepareProof: row.prepareProof, gateCompletionProof: row.gateCompletionProof,
      auditActor: row.auditActor as ScheduledTaskGraphAuditActor,
      ...(Object.hasOwn(row, "scheduledWaitId") ? { scheduledWaitId: row.scheduledWaitId as string } : {}) }
  }
  return null
}

function validAuditActor(value: unknown): value is ScheduledTaskGraphAuditActor {
  const actor = record(value)
  return Boolean(actor && exactKeys(actor, ["taskId", "attemptCount", "leaseOwner"])
    && validId(actor.taskId) && positive(actor.attemptCount) && validId(actor.leaseOwner))
}

function parseLegacyRequest(row: Record<string, unknown>): ScheduledTaskGraphLegacyRpcRequest | null {
  const keys = Object.keys(row).sort().join(",")
  if (!plainObject(row.owner) || !exactKeys(row.owner, LEGACY_OWNER_KEYS)
    || ![row.owner.userId, row.owner.sessionId, row.owner.turnId, row.owner.rootTaskId, row.owner.turnLeaseOwnerId].every(validId)
    || !positive(row.owner.rootAttemptCount) || !positive(row.owner.turnLeaseVersion)
    || !Object.hasOwn(row, "attestation")
    || !["attestation,owner", "attestation,owner,prepareProof", "attestation,owner,prepareProof,scheduledWaitId"].includes(keys)
    || Object.hasOwn(row, "scheduledWaitId") && (row.prepareProof === undefined || !validId(row.scheduledWaitId)
      || !row.scheduledWaitId.startsWith(`agent-question:${row.owner.turnId}:canonical:`))) return null
  return { action: "legacy", owner: row.owner as unknown as ScheduledTaskGraphGateRequestOwner, attestation: row.attestation,
    ...(Object.hasOwn(row, "prepareProof") ? { prepareProof: row.prepareProof } : {}),
    ...(Object.hasOwn(row, "scheduledWaitId") ? { scheduledWaitId: row.scheduledWaitId as string } : {}) }
}

/** Allows an exact live child lease even when DurableWait has released the Root Turn lease. */
export function scheduledTaskGraphGateTaskLeaseIsCurrent(value: unknown, input: {
  owner: ScheduledTaskGraphGateRequestOwner; taskId: string; leaseOwnerId: string; attemptCount: number; now?: number
}): boolean {
  const task = record(value), expiry = dateNumber(task?.leaseExpiresAt), now = input.now ?? Date.now()
  return Boolean(task && task.id === input.taskId && task.sessionId === input.owner.sessionId && task.turnId === input.owner.turnId
    && task.rootTaskId === input.owner.rootTaskId && task.parentTaskId === input.owner.rootTaskId && task.depth === 1
    && task.role === "prepare" && task.taskType === GATE_TASK_TYPE && task.status === "running"
    && task.attemptCount === input.attemptCount && task.leaseOwner === input.leaseOwnerId
    && Number.isFinite(expiry) && expiry > now && task.interruptRequestedAt == null && task.closedAt == null
    && sameJson(task.expectedOutputSchema, GATE_SCHEMA) && Array.isArray(task.allowedActions) && task.allowedActions.length === 0)
}

/** Binds child work to this exact active Run/Root/Turn, including a released suspended Turn. */
export function scheduledTaskGraphGateTurnIsCurrent(value: unknown, input: {
  owner: ScheduledTaskGraphGateRequestOwner; mode: "gate_child" | "root_execute"; now?: number
}): boolean {
  const turn = record(value), now = input.now ?? Date.now(), expiry = dateNumber(turn?.leaseExpiresAt)
  if (!turn || turn.id !== input.owner.turnId || turn.userId !== input.owner.userId || turn.sessionId !== input.owner.sessionId
    || turn.rootTaskId !== input.owner.rootTaskId) return false
  if (input.mode === "gate_child") {
    // The child lease is the live execution authority. The Root may be holding
    // a newer lease or have released it while waiting for this child.
    if (turn.status === "in_progress") return validId(turn.leaseOwnerId) && positive(turn.leaseVersion)
      && Number.isFinite(expiry) && expiry > now
    return ["waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "waiting_for_tool"]
      .includes(String(turn.status)) && turn.leaseOwnerId === null && turn.leaseExpiresAt === null
  }
  return turn.status === "in_progress" && turn.leaseOwnerId === input.owner.turnLeaseOwnerId
    && turn.leaseVersion === input.owner.turnLeaseVersion && Number.isFinite(expiry) && expiry > now
}

export function scheduledTaskGraphExecuteGateCompletionProof(value: unknown): Record<string, unknown> | null {
  const proof = record(value), gate = record(proof?.gate)
  return proof && exactKeys(proof, ["schemaVersion", "graphRevision", "prepareProof", "gate"])
    && proof.schemaVersion === "agent-harness.v2.scheduled-taskgraph-gate-completion.v1"
    && positive(proof.graphRevision) && Object.hasOwn(proof, "prepareProof") && gate
    && exactKeys(gate, ["taskId", "attemptCount", "resultDigest", "completedEventRevision"])
    && validId(gate.taskId) && positive(gate.attemptCount) && isDigest(gate.resultDigest)
    && positive(gate.completedEventRevision) && gate.completedEventRevision === proof.graphRevision ? proof : null
}

/** Derives only the execution identity needed to lock an Audit actor before full proof validation. */
export function scheduledTaskGraphAuditExecutionOwner(request: Pick<ScheduledTaskGraphAuditExecuteRpcRequest, "owner">,
  proof: unknown): ScheduledTaskGraphPipelineOwner | null {
  const owner = record(record(record(record(proof)?.prepareProof)?.receipt)?.owner)
  return owner && validId(owner.executionId) && nonNegative(owner.executionAttemptCount)
    ? { ...request.owner, executionId: owner.executionId, executionAttemptCount: Number(owner.executionAttemptCount) } : null
}

function record(value: unknown): Record<string, unknown> | null { return plainObject(value) ? value as Record<string, unknown> : null }
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key))
}
function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const keys = [...required, ...optional], actual = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(value, key)) && actual.length <= keys.length
    && actual.every(key => typeof key === "string" && keys.includes(key))
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function dateNumber(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
