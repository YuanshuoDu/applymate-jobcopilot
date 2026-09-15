import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const PLAN_LEDGER_EVENT_TYPES = ['plan.revision', 'plan.command', 'plan.observation'] as const
export type PlanLedgerEventType = typeof PLAN_LEDGER_EVENT_TYPES[number]

export const PLAN_LEDGER_MAX_REVISION = 8
export const PLAN_LEDGER_MAX_PLANS = 16
export const PLAN_LEDGER_MAX_STEPS = 8
export const PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES = 240
export const PLAN_LEDGER_MAX_LOCAL_ID_BYTES = 128
export const PLAN_LEDGER_MAX_RECEIPT_BYTES = 64 * 1024
export const PLAN_LEDGER_MAX_COMMAND_RECEIPT_BYTES = 8 * 1024

const SAFE_SEQUENCE = /^(0|[1-9]\d*)$/
const SAFE_HASH = /^sha256:[0-9a-f]{64}$/
const PLAN_COMMAND_KINDS = ['tool_call', 'delegate', 'join'] as const
const COMMAND_STATUSES = ['completed', 'failed', 'cancelled'] as const
const DEPENDENCY_LIMIT = 8
const ID_BYTES = 256

type Row = Record<string, unknown>
type PlanCommandKind = typeof PLAN_COMMAND_KINDS[number]
type PlanCommandStatus = typeof COMMAND_STATUSES[number]
export type PlanLedgerActionKind = PlanCommandKind | 'request_input' | 'propose_completion' | 'replan_required'
export type PlanLedgerStepStatus = PlanCommandStatus | 'waiting_for_user' | 'completion_proposed' | 'replan_required'

export interface PlanLedgerStep {
  readonly localId: string
  readonly actionKind: PlanLedgerActionKind
  readonly status: PlanLedgerStepStatus
  readonly dependencyCount: number
}

export interface PlanLedgerEventEnvelope {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly type: PlanLedgerEventType
  readonly actor: 'orchestrator' | 'subagent'
  readonly sequence: string
  readonly receipt:
    | { readonly kind: 'revision'; readonly planCallId: string; readonly goalRevision: number; readonly planRevision: number; readonly basedOnPlanRevision: number | null; readonly proposalHash?: string }
    | { readonly kind: 'step'; readonly planCallId: string; readonly planRevision: number; readonly observationId: string; readonly step: PlanLedgerStep }
}

export function isPlanLedgerEventType(value: unknown): value is PlanLedgerEventType {
  return typeof value === 'string' && (PLAN_LEDGER_EVENT_TYPES as readonly string[]).includes(value)
}

function plain(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exact(row: Row, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(row, key)) && Object.keys(row).every(key => allowed.has(key))
}

function bytes(value: string): number { return new TextEncoder().encode(value).byteLength }

function safeId(value: unknown, maxBytes = ID_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && bytes(value) <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)
}

function positive(value: unknown, maximum?: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && (maximum === undefined || value <= maximum)
}

function boundedJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && !plain(value))) return false
  seen.add(value)
  const valid = Object.values(value).every(item => boundedJson(item, seen))
  seen.delete(value)
  return valid
}

function stringList(value: unknown, maximum: number, maxBytes: number, sorted = false): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return false
  const seen = new Set<string>()
  let previous = ''
  for (const item of value) {
    if (!safeId(item, maxBytes) || seen.has(item) || (sorted && previous >= item)) return false
    seen.add(item)
    previous = item
  }
  return true
}

function stepContent(value: unknown): PlanLedgerStep | null {
  if (!plain(value) || value.kind !== 'plan_command' && value.kind !== 'plan_control') return null
  if (value.kind === 'plan_command') {
    if (!exact(value, ['kind', 'localId', 'commandKind', 'dependsOn', 'status', 'errorCode'], ['output']) ||
      !safeId(value.localId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !PLAN_COMMAND_KINDS.includes(value.commandKind as PlanCommandKind) ||
      !stringList(value.dependsOn, DEPENDENCY_LIMIT, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !COMMAND_STATUSES.includes(value.status as PlanCommandStatus) ||
      (value.errorCode !== null && !safeId(value.errorCode, 256)) || (Object.prototype.hasOwnProperty.call(value, 'output') && (!plain(value.output) || !boundedJson(value.output)))) return null
    if (value.status === 'completed' && value.errorCode !== null) return null
    return { localId: value.localId, actionKind: value.commandKind as PlanCommandKind, status: value.status as PlanCommandStatus, dependencyCount: value.dependsOn.length }
  }
  if (!safeId(value.localId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !safeId(value.status, 64)) return null
  if (value.status === 'waiting_for_user') {
    if (!exact(value, ['kind', 'localId', 'status', 'question'], ['approvalBoundary']) || !safeId(value.question, 4_000) ||
      (value.approvalBoundary !== undefined && !safeId(value.approvalBoundary, 256))) return null
    return { localId: value.localId, actionKind: 'request_input', status: 'waiting_for_user', dependencyCount: 0 }
  }
  if (value.status === 'completion_proposed') {
    if (!exact(value, ['kind', 'localId', 'status', 'dependsOn', 'completionCriteria']) || !stringList(value.dependsOn, DEPENDENCY_LIMIT, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !stringList(value.completionCriteria, 16, 1_000)) return null
    return { localId: value.localId, actionKind: 'propose_completion', status: 'completion_proposed', dependencyCount: value.dependsOn.length }
  }
  if (value.status === 'replan_required') {
    if (!exact(value, ['kind', 'localId', 'status', 'dependsOn', 'reason', 'failedTaskIds']) || value.reason !== 'child_failure' || !stringList(value.dependsOn, DEPENDENCY_LIMIT, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !stringList(value.failedTaskIds, 16, ID_BYTES, true)) return null
    return { localId: value.localId, actionKind: 'replan_required', status: 'replan_required', dependencyCount: value.dependsOn.length }
  }
  return null
}

function parsePayload(type: PlanLedgerEventType, value: unknown): PlanLedgerEventEnvelope['receipt'] | null {
  if (!plain(value) || !boundedJson(value)) return null
  if (type === 'plan.revision') {
    if (!exact(value, ['planCallId', 'goalRevision', 'planRevision', 'basedOnPlanRevision'], ['proposalHash']) || !safeId(value.planCallId, PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES) ||
      !positive(value.goalRevision, 2_147_483_647) || !positive(value.planRevision, PLAN_LEDGER_MAX_REVISION) ||
      (value.basedOnPlanRevision !== null && (typeof value.basedOnPlanRevision !== 'number' || !Number.isSafeInteger(value.basedOnPlanRevision) || value.basedOnPlanRevision < 0 || value.basedOnPlanRevision >= PLAN_LEDGER_MAX_REVISION)) ||
      value.planRevision !== (value.basedOnPlanRevision === null ? 1 : value.basedOnPlanRevision + 1) || (value.proposalHash !== undefined && (typeof value.proposalHash !== 'string' || !SAFE_HASH.test(value.proposalHash)))) return null
    return { kind: 'revision', planCallId: value.planCallId, goalRevision: value.goalRevision, planRevision: value.planRevision, basedOnPlanRevision: value.basedOnPlanRevision as number | null, ...(value.proposalHash === undefined ? {} : { proposalHash: value.proposalHash }) }
  }
  if (!exact(value, ['planCallId', 'planRevision', 'observationId', 'content']) || !safeId(value.planCallId, PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES) || !positive(value.planRevision, PLAN_LEDGER_MAX_REVISION) || !safeId(value.observationId, PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES)) return null
  const step = stepContent(value.content)
  return step ? { kind: 'step', planCallId: value.planCallId, planRevision: value.planRevision, observationId: value.observationId, step } : null
}

/** Accepts only a server-shaped plan event and returns a redacted step projection. */
export function parsePlanLedgerEvent(value: unknown, expectedSessionId: string): PlanLedgerEventEnvelope | null {
  try {
    if (!plain(value) || !safeId(expectedSessionId) || !isPlanLedgerEventType(value.type) ||
      !exact(value, ['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'sequence', 'payload'], ['correlationId', 'causationId', 'idempotencyKey', 'createdAt']) ||
      value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || !safeId(value.id) || value.sessionId !== expectedSessionId || !safeId(value.turnId) || !safeId(value.taskId) || value.itemId !== null ||
      (value.actor !== 'orchestrator' && value.actor !== 'subagent') || typeof value.sequence !== 'string' || !SAFE_SEQUENCE.test(value.sequence) || value.sequence.length > 39) return null
    if (value.correlationId !== undefined && !safeId(value.correlationId)) return null
    if (value.causationId !== undefined && value.causationId !== null && !safeId(value.causationId)) return null
    if (value.idempotencyKey !== undefined && value.idempotencyKey !== null && !safeId(value.idempotencyKey)) return null
    if (value.createdAt !== undefined && !safeId(value.createdAt, 64)) return null
    const receipt = parsePayload(value.type, value.payload)
    const encodedBytes = bytes(JSON.stringify(value))
    const maxBytes = value.type === 'plan.revision' ? PLAN_LEDGER_MAX_RECEIPT_BYTES : PLAN_LEDGER_MAX_COMMAND_RECEIPT_BYTES
    if (!receipt || encodedBytes > maxBytes) return null
    return { id: value.id, sessionId: value.sessionId, turnId: value.turnId, taskId: value.taskId, type: value.type, actor: value.actor, sequence: value.sequence, receipt }
  } catch { return null }
}
