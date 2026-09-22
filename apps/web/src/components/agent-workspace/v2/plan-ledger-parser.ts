import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const PLAN_LEDGER_EVENT_TYPES = ['plan.revision', 'plan.command', 'plan.observation', 'plan.task_graph'] as const
export type PlanLedgerEventType = typeof PLAN_LEDGER_EVENT_TYPES[number]

export const PLAN_LEDGER_MAX_REVISION = 8
export const PLAN_LEDGER_MAX_PLANS = 16
export const PLAN_LEDGER_MAX_STEPS = 8
export const PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES = 240
export const PLAN_LEDGER_MAX_LOCAL_ID_BYTES = 128
export const PLAN_LEDGER_MAX_RECEIPT_BYTES = 64 * 1024
export const PLAN_LEDGER_MAX_COMMAND_RECEIPT_BYTES = 8 * 1024
export const PLAN_LEDGER_MAX_GRAPH_EVENTS_PER_NODE = 4

const SAFE_SEQUENCE = /^(0|[1-9]\d*)$/
const SAFE_HASH = /^sha256:[0-9a-f]{64}$/
const PLAN_COMMAND_KINDS = ['tool_call', 'delegate', 'join'] as const
const COMMAND_STATUSES = ['completed', 'failed', 'cancelled'] as const
const TASK_GRAPH_STATUSES = ['pending', 'ready', 'running', 'completed', 'failed', 'waiting', 'cancelled'] as const
const TASK_GRAPH_PHASES = ['start', 'complete', 'fail', 'wait', 'cancel', 'retry'] as const
const DEPENDENCY_LIMIT = 8
const ID_BYTES = 256
const TASK_GRAPH_EVENT_ID_BYTES = 512

type Row = Record<string, unknown>
type PlanCommandKind = typeof PLAN_COMMAND_KINDS[number]
type PlanCommandStatus = typeof COMMAND_STATUSES[number]
export type PlanGraphStatus = typeof TASK_GRAPH_STATUSES[number]
export type PlanGraphPhase = typeof TASK_GRAPH_PHASES[number]
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
    | { readonly kind: 'graph'; readonly runKey: string; readonly eventId: string; readonly planCallId: string; readonly planRevision: number; readonly nodeId: string; readonly phase: PlanGraphPhase; readonly attempt: number; readonly nodes: readonly PlanGraphNodeProjection[] }
}

export interface PlanGraphNodeProjection {
  readonly nodeId: string
  readonly dependencyIds: readonly string[]
  readonly phase?: PlanGraphPhase
  readonly attempt?: number
  readonly status: PlanGraphStatus
}

export interface PlanGraphEventPayload {
  readonly runKey: string
  readonly eventId: string
  readonly nodeId: string
  readonly phase: PlanGraphPhase
  readonly attempt: number
  readonly nodes: readonly PlanGraphNodeProjection[]
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

function graphRunKey(value: unknown, taskId: string): { runKey: string; planCallId: string; planRevision: number } | null {
  if (!safeId(value, 256) || !value.startsWith(`${taskId}:`)) return null
  const suffix = value.slice(taskId.length + 1)
  const separator = suffix.lastIndexOf(':')
  if (separator <= 0) return null
  const planCallId = suffix.slice(0, separator)
  const planRevision = Number(suffix.slice(separator + 1))
  if (!safeId(planCallId, PLAN_LEDGER_MAX_PLAN_CALL_ID_BYTES) || !positive(planRevision, PLAN_LEDGER_MAX_REVISION)) return null
  return { runKey: value, planCallId, planRevision }
}

function graphEventId(runKey: string, nodeId: string, phase: PlanGraphPhase, attempt: number): string {
  return attempt === 1 ? `${runKey}:${nodeId}:${phase}` : `${runKey}:${nodeId}:attempt:${attempt}:${phase}`
}

function graphFields(payload: unknown, taskId: string): Extract<PlanLedgerEventEnvelope['receipt'], { kind: 'graph' }> | null {
  if (!plain(payload)) return null

  if (exact(payload, ['runKey', 'eventId', 'nodeId', 'phase', 'attempt', 'nodes'])) {
    const scope = graphRunKey(payload.runKey, taskId)
    const attempt = payload.attempt
    if (!scope || !safeId(payload.eventId, TASK_GRAPH_EVENT_ID_BYTES) || !safeId(payload.nodeId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) ||
      !TASK_GRAPH_PHASES.includes(payload.phase as PlanGraphPhase) || !positive(attempt, 2) || !Array.isArray(payload.nodes) ||
      payload.nodes.length < 1 || payload.nodes.length > PLAN_LEDGER_MAX_STEPS ||
      payload.eventId !== graphEventId(scope.runKey, payload.nodeId, payload.phase as PlanGraphPhase, attempt)) return null
    const nodes: PlanGraphNodeProjection[] = []
    const ids = new Set<string>()
    for (const candidate of payload.nodes) {
      if (!plain(candidate) || !exact(candidate, ['nodeId', 'dependencyIds', 'status'], ['phase', 'attempt']) ||
        !safeId(candidate.nodeId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || ids.has(candidate.nodeId) ||
        !stringList(candidate.dependencyIds, PLAN_LEDGER_MAX_STEPS, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) ||
        !TASK_GRAPH_STATUSES.includes(candidate.status as PlanGraphStatus) ||
        (candidate.phase !== undefined && (!TASK_GRAPH_PHASES.includes(candidate.phase as PlanGraphPhase) || !positive(candidate.attempt, 2))) ||
        (candidate.phase === undefined && candidate.attempt !== undefined)) return null
      ids.add(candidate.nodeId)
      nodes.push({ nodeId: candidate.nodeId, dependencyIds: candidate.dependencyIds, status: candidate.status as PlanGraphStatus, ...(candidate.phase === undefined ? {} : { phase: candidate.phase as PlanGraphPhase, attempt: candidate.attempt as number }) })
    }
    const current = nodes.find(node => node.nodeId === payload.nodeId)
    if (!current || current.phase !== payload.phase || current.attempt !== attempt || nodes.some(node => node.dependencyIds.some(dependency => !ids.has(dependency) || dependency === node.nodeId))) return null
    return { kind: 'graph', ...scope, eventId: payload.eventId, nodeId: payload.nodeId, phase: payload.phase as PlanGraphPhase, attempt, nodes }
  }

  if (!exact(payload, ['runKey', 'event', 'state'])) return null
  const scope = graphRunKey(payload.runKey, taskId)
  const event = payload.event
  const state = plain(payload.state) ? payload.state : null
  const statuses = state && plain(state.statuses) ? state.statuses : null
  if (!scope || !plain(event) || !exact(event, ['type', 'nodeId', 'eventId'], ['attempt']) || !state ||
    !exact(state, ['nodes', 'statuses', 'readyNodeIds', 'blockedReasons', 'appliedEvents']) ||
    !Array.isArray(state.nodes) || state.nodes.length < 1 || state.nodes.length > PLAN_LEDGER_MAX_STEPS || !statuses) return null

  const phase = event.type
  const nodeId = event.nodeId
  const eventId = event.eventId
  const attempt = event.attempt === undefined ? 1 : event.attempt
  if (!safeId(nodeId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) || !safeId(eventId, TASK_GRAPH_EVENT_ID_BYTES) ||
    !TASK_GRAPH_PHASES.includes(phase as PlanGraphPhase) || !positive(attempt, 2) || (phase === 'retry' && attempt !== 2)) return null

  const nodes: Array<{ id: string; dependsOn: readonly string[] }> = []
  const ids = new Set<string>()
  for (const candidate of state.nodes) {
    if (!plain(candidate) || !exact(candidate, ['id', 'dependsOn']) || !safeId(candidate.id, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) ||
      ids.has(candidate.id) || !stringList(candidate.dependsOn, PLAN_LEDGER_MAX_STEPS, PLAN_LEDGER_MAX_LOCAL_ID_BYTES)) return null
    ids.add(candidate.id)
    nodes.push({ id: candidate.id, dependsOn: candidate.dependsOn })
  }
  if (!ids.has(nodeId) || Object.keys(statuses).length !== ids.size || Object.keys(statuses).some(id => !ids.has(id)) ||
    nodes.some(node => node.dependsOn.some(dependency => !ids.has(dependency) || dependency === node.id)) || !Array.isArray(state.appliedEvents) ||
    state.appliedEvents.length < 1 || state.appliedEvents.length > PLAN_LEDGER_MAX_STEPS * PLAN_LEDGER_MAX_GRAPH_EVENTS_PER_NODE) return null
  const latestEvents = new Map<string, { phase: PlanGraphPhase; attempt: number; eventId: string }>()
  for (const candidate of state.appliedEvents) {
    if (!plain(candidate) || !exact(candidate, ['type', 'nodeId', 'eventId'], ['attempt']) ||
      !TASK_GRAPH_PHASES.includes(candidate.type as PlanGraphPhase) || !safeId(candidate.nodeId, PLAN_LEDGER_MAX_LOCAL_ID_BYTES) ||
      !ids.has(candidate.nodeId) || !safeId(candidate.eventId, TASK_GRAPH_EVENT_ID_BYTES)) return null
    const candidateAttempt = candidate.attempt === undefined ? 1 : candidate.attempt
    if (!positive(candidateAttempt, 2) || (candidate.type === 'retry' && candidateAttempt !== 2) ||
      candidate.eventId !== graphEventId(scope.runKey, candidate.nodeId, candidate.type as PlanGraphPhase, candidateAttempt)) return null
    latestEvents.set(candidate.nodeId, { phase: candidate.type as PlanGraphPhase, attempt: candidateAttempt, eventId: candidate.eventId })
  }
  if (state.appliedEvents[state.appliedEvents.length - 1] === undefined ||
    !plain(state.appliedEvents[state.appliedEvents.length - 1]) || state.appliedEvents[state.appliedEvents.length - 1]!.eventId !== eventId ||
    latestEvents.get(nodeId)?.eventId !== eventId) return null
  const status = statuses[nodeId]
  if (!TASK_GRAPH_STATUSES.includes(status as PlanGraphStatus) || eventId !== graphEventId(scope.runKey, nodeId, phase as PlanGraphPhase, attempt)) return null
  if (nodes.some(node => !TASK_GRAPH_STATUSES.includes(statuses[node.id] as PlanGraphStatus))) return null
  const graphNodes: PlanGraphNodeProjection[] = nodes.map(node => {
    const latest = latestEvents.get(node.id)
    const nodeStatus = statuses[node.id]
    return {
      nodeId: node.id, dependencyIds: node.dependsOn, status: nodeStatus as PlanGraphStatus,
      ...(latest ? { phase: latest.phase, attempt: latest.attempt } : {}),
    }
  })
  const current = graphNodes.find(node => node.nodeId === nodeId)
  if (!current || current.status !== status || current.phase !== phase || current.attempt !== attempt) return null
  return {
    kind: 'graph', ...scope, eventId, nodeId, phase: phase as PlanGraphPhase, attempt, nodes: graphNodes,
  }
}

/** Validates and strips persisted graph state down to the fields needed by the plan UI. */
export function projectPlanTaskGraphPayload(value: unknown, taskId: string): PlanGraphEventPayload | null {
  const receipt = graphFields(value, taskId)
  if (!receipt) return null
  return {
    runKey: receipt.runKey, eventId: receipt.eventId, nodeId: receipt.nodeId, phase: receipt.phase,
    attempt: receipt.attempt, nodes: receipt.nodes,
  }
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

function parsePayload(type: PlanLedgerEventType, value: unknown, taskId: string): PlanLedgerEventEnvelope['receipt'] | null {
  if (type === 'plan.task_graph') return graphFields(value, taskId)
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
    const receipt = parsePayload(value.type, value.payload, value.taskId)
    const encodedBytes = bytes(JSON.stringify(value))
    const maxBytes = value.type === 'plan.revision' ? PLAN_LEDGER_MAX_RECEIPT_BYTES : PLAN_LEDGER_MAX_COMMAND_RECEIPT_BYTES
    if (!receipt || encodedBytes > maxBytes) return null
    return { id: value.id, sessionId: value.sessionId, turnId: value.turnId, taskId: value.taskId, type: value.type, actor: value.actor, sequence: value.sequence, receipt }
  } catch { return null }
}
