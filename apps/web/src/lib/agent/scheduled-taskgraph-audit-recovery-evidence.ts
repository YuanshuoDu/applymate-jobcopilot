import { Prisma } from '@prisma/client'
import { scheduledTaskGraphAuditGateQuestionId, scheduledTaskGraphAuditGateWaitKey, scheduledTaskGraphAuditRecoveryEventIsActivity,
  scheduledTaskGraphAuditRecoveryItems, scheduledTaskGraphAuditWaitKey } from './scheduled-taskgraph-audit-recovery-graph-item'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { parseScheduledGateChoiceBinding, scheduledGateChoiceState,
  type ScheduledTaskGraphGateChoiceBinding as GateBinding } from './scheduled-taskgraph-gate-choice-evidence'

const MARKER_SCHEMA = 'agent-harness.v2.scheduled-pipeline-recovery-step.v1'
const MARKER_KEY = 'scheduledPipelineRecoveryStep'
const MAX_STEPS = 128
const MAX_ROWS = 512
const WAIT_TIMEOUT_MS = 86_400_000
type Row = Record<string, unknown>
type OwnerIdentity = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
type Source = Readonly<{ sourceEventId: string; stepId: string; ordinal: number }>
type RecoveryMarker = Readonly<{ schemaVersion: typeof MARKER_SCHEMA; kind: 'scheduled_pipeline_recovery'; owner: OwnerIdentity; rootAttemptCount: number; sourceEventId: string; sourceStepId: string;
  sourceStepOrdinal: number; sourceInputThroughSequence: string; recoveryStepId: string; recoveryCursor: number;
  predecessorStepId: string; inputThroughSequence: string }>

/** Validates the operational recovery tail against the exact persisted Worker receipts. */
export async function validateScheduledTaskGraphAuditRecoveryEvidence(input: Readonly<{
  reader: Prisma.TransactionClient
  owner: ScheduledTaskGraphPipelineOwner
  source: Source
  sourceInputThroughSequence: string
  rootAttemptCount: number
}>): Promise<boolean> {
  const { reader, owner, source, sourceInputThroughSequence, rootAttemptCount } = input
  if (!validOwner(owner) || !positive(rootAttemptCount) || owner.rootAttemptCount !== rootAttemptCount
    || !validId(source.sourceEventId) || !validId(source.stepId) || !nonNegative(source.ordinal)
    || !validCursor(sourceInputThroughSequence)) return false
  try {
    const steps = await reader.agentStep.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: owner.rootTaskId, ordinal: { gt: source.ordinal } }, orderBy: { ordinal: 'asc' }, take: MAX_STEPS + 1,
    select: { id: true, taskId: true, ordinal: true, attempt: true, status: true, errorCode: true,
      inputThroughSequence: true, consumedInputIds: true, modelProfileSnapshot: true, inputTokens: true,
      outputTokens: true, estimatedCostUsd: true } })
    if (steps.length > MAX_STEPS) return false
    if (!steps.length) return true
    const ids = steps.map(step => step.id)
    if (ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) return false
    const [events, items, waits] = await Promise.all([
      reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
        correlationId: { in: ids } }, take: MAX_ROWS + 1,
      select: { id: true, taskId: true, itemId: true, type: true, actor: true, correlationId: true, idempotencyKey: true, payload: true } }),
      reader.agentItem.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
        stepId: { in: ids } }, take: MAX_ROWS + 1,
      select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
        phase: true, revision: true, content: true } }),
      reader.agentWaitCondition.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
        parentTaskId: owner.rootTaskId, stepId: { in: ids } }, take: MAX_ROWS + 1,
      select: { id: true, userId: true, sessionId: true, turnId: true, parentTaskId: true, stepId: true,
        idempotencyKey: true, targetTaskIds: true, mode: true, status: true, matchedTaskIds: true, result: true } }),
    ])
    if (events.length > MAX_ROWS || items.length > MAX_ROWS || waits.length > MAX_ROWS) return false
    const targetIds = new Set<string>()
    for (const wait of waits) for (const id of idsFrom(wait.targetTaskIds) ?? []) targetIds.add(id)
    for (const item of items) {
      const gateId = parseScheduledGateChoiceBinding(record(parse(item.content))?.scheduledGateChoiceBinding)?.gateTaskId
      if (gateId) targetIds.add(gateId)
    }
    const tasks = targetIds.size ? await reader.subAgentTask.findMany({ where: { id: { in: [...targetIds] },
      sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId },
    select: { id: true, parentTaskId: true, rootTaskId: true, sessionId: true, turnId: true, depth: true,
      role: true, taskType: true, maxAttempts: true, session: { select: { userId: true } } } }) : []
    if (tasks.length !== targetIds.size) return false
    const taskById = new Map<string, Row>()
    for (const task of tasks) {
      const row = record(task)
      if (!row || !validId(row.id) || taskById.has(row.id)) return false
      taskById.set(row.id, row)
    }
    const ownerIdentity = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId }
    let previousId = source.stepId, previousOrdinal = source.ordinal, previousCursor = BigInt(sourceInputThroughSequence), cursor = 0
    for (const stepValue of steps) {
      const step = record(stepValue)
      if (!step || !await validateStep(reader, step, ownerIdentity, owner, source, rootAttemptCount, sourceInputThroughSequence,
        previousId, previousOrdinal, previousCursor, cursor,
        events.filter(event => event.correlationId === step.id), items.filter(item => item.stepId === step.id),
        waits.filter(wait => wait.stepId === step.id), taskById)) return false
      const marker = parseMarker(record(parse(step.modelProfileSnapshot))?.[MARKER_KEY])
      if (!marker) return false
      previousId = String(step.id); previousOrdinal = Number(step.ordinal)
      previousCursor = BigInt(marker.inputThroughSequence); cursor = marker.recoveryCursor
    }
    return true
  } catch { return false }
}

async function validateStep(reader: Prisma.TransactionClient, step: Row, owner: OwnerIdentity, pipelineOwner: ScheduledTaskGraphPipelineOwner, source: Source, attempt: number, sourceCursor: string, previousId: string,
  previousOrdinal: number, previousCursor: bigint, previousRecoveryCursor: number, events: Row[], items: Row[], waits: Row[],
  tasks: Map<string, Row>): Promise<boolean> {
  items = await scheduledTaskGraphAuditRecoveryItems({ reader, owner: pipelineOwner, stepId: String(step.id), items })
  const marker = parseMarker(record(parse(step.modelProfileSnapshot))?.[MARKER_KEY]), inputCursor = cursorValue(step.inputThroughSequence)
  const consumed = parse(step.consumedInputIds), starts = events.filter(event => event.type === 'step.started')
  const completes = events.filter(event => event.type === 'step.completed')
  const rowAttempt = step.attempt, ordinal = step.ordinal, status = step.status
  if (!marker || !same(marker.owner, owner) || marker.rootAttemptCount !== attempt || marker.sourceEventId !== source.sourceEventId
    || marker.sourceStepId !== source.stepId || marker.sourceStepOrdinal !== source.ordinal
    || marker.sourceInputThroughSequence !== sourceCursor || marker.recoveryStepId !== step.id
    || marker.predecessorStepId !== previousId || marker.recoveryCursor !== previousRecoveryCursor + 1
    || marker.inputThroughSequence !== inputCursor || !inputCursor || BigInt(inputCursor) < previousCursor
    || step.taskId !== owner.rootTaskId || !positive(ordinal) || ordinal <= previousOrdinal || rowAttempt !== 1
    || !['streaming', 'interrupted', 'waiting_for_tool', 'waiting_for_user', 'completed'].includes(String(status))
    || !Array.isArray(consumed) || consumed.length !== 0 || !zero(step.inputTokens) || !zero(step.outputTokens)
    || !zeroCost(step.estimatedCostUsd) || events.some(event => scheduledTaskGraphAuditRecoveryEventIsActivity(event.type) || event.type === 'final.rejected')
    || items.some(item => item.taskId !== owner.rootTaskId || item.stepId !== step.id)
    || !awaitsValid(waits, owner, String(step.id), tasks)) return false
  const startGood = starts.length <= 1 && starts.every(event => startMatches(event, step, marker, owner.rootTaskId, owner.turnId))
  if (!startGood) return false
  if (status === 'streaming' || status === 'interrupted') return items.length === 0 && completes.length === 0
    && completionState(starts, completes, step, owner.rootTaskId, owner.turnId, 'open')
  if (starts.length !== 1 || completes.length !== 1) return false
  if (status === 'waiting_for_user') return step.errorCode === null && gateChoiceItem(items, step, owner, pipelineOwner, attempt, tasks)
    && completionState(starts, completes, step, owner.rootTaskId, owner.turnId, 'waiting_for_user')
  if (status === 'completed') return items.length === 0 && step.errorCode === null
    && completionState(starts, completes, step, owner.rootTaskId, owner.turnId, 'completed')
  if (status !== 'waiting_for_tool') return false
  if (step.errorCode === 'scheduled_audit_completion_unverified') return items.length === 0
    && waits.every(wait => wait.status === 'ready')
    && completionState(starts, completes, step, owner.rootTaskId, owner.turnId, 'blocker')
  const completion = record(parse(completes[0]?.payload)), waitId = completion?.waitId
  return step.errorCode === null && items.length === 0 && validId(waitId)
    && waits.filter(wait => wait.id === waitId).length === 1
    && completionState(starts, completes, step, owner.rootTaskId, owner.turnId, 'waiting_for_dependency')
}

function completionState(starts: Row[], completes: Row[], step: Row, rootTaskId: string, turnId: string, mode: string): boolean {
  if (mode === 'open') return starts.length <= 1
  const payload = record(parse(completes[0]?.payload)), status = step.status === 'waiting_for_tool'
    ? 'waiting_for_dependency' : step.status
  const blocker = mode === 'blocker', waiting = mode === 'waiting_for_dependency'
  const keys = blocker ? ['stepId', 'status', 'errorCode', 'taskId'] : waiting ? ['stepId', 'status', 'taskId', 'waitId'] : ['stepId', 'status', 'taskId']
  const event = completes[0]
  return !!payload && exactKeys(payload, keys) && event?.actor === 'orchestrator' && event.taskId === rootTaskId
    && event.itemId === null && event.correlationId === step.id && event.idempotencyKey === `turn:${turnId}:event:step-completed:${step.id}`
    && payload.stepId === step.id && payload.status === status && payload.taskId === rootTaskId
    && (blocker ? payload.errorCode === step.errorCode && step.errorCode === 'scheduled_audit_completion_unverified' : step.errorCode === null)
    && (!waiting || validId(payload.waitId))
}

function startMatches(eventValue: unknown, step: Row, marker: Row, rootTaskId: string, turnId: string): boolean {
  const event = record(eventValue), payload = record(parse(event?.payload))
  return !!event && !!payload && exactKeys(payload, ['stepId', 'ordinal', 'taskId', MARKER_KEY])
    && event.type === 'step.started' && event.actor === 'orchestrator' && event.taskId === rootTaskId && event.itemId === null
    && event.correlationId === step.id && event.idempotencyKey === `turn:${turnId}:event:step-started:${step.id}`
    && payload.stepId === step.id && payload.ordinal === step.ordinal && payload.taskId === rootTaskId && same(parse(payload[MARKER_KEY]), marker)
}

function gateChoiceItem(items: Row[], step: Row, owner: OwnerIdentity, pipelineOwner: ScheduledTaskGraphPipelineOwner,
  attempt: number, tasks: Map<string, Row>): boolean {
  if (items.length !== 1) return false
  const item = items[0]!, content = record(parse(item.content)), binding = parseScheduledGateChoiceBinding(content?.scheduledGateChoiceBinding)
  if (!binding) return false
  const waitId = scheduledTaskGraphAuditGateQuestionId(binding), state = scheduledGateChoiceState(content, item.status, binding, waitId)
  const task = binding && tasks.get(binding.gateTaskId)
  return !!state && item.id === `agent-wait:question:${waitId}` && item.type === 'question'
    && item.stepId === step.id && item.taskId === owner.rootTaskId && sameOwner(binding.owner, pipelineOwner, attempt)
    && !!task && taskMatches(task, owner, binding.gateTaskId, 'gate')
}

function awaitsValid(waits: Row[], owner: OwnerIdentity, stepId: string, tasks: Map<string, Row>): boolean {
  return waits.every(wait => {
    const ids = idsFrom(wait.targetTaskIds), result = record(parse(wait.result)), request = record(result?.request)
    if (!ids || ids.length !== 1 || !request || !validId(ids[0])) return false
    const target = ids[0]!, task = tasks.get(target), hasGate = Object.hasOwn(request, 'scheduledGate')
    if (hasGate) {
      const gate = record(request.scheduledGate)
      return !!gate && exactKeys(gate, ['gateTaskId', 'requestAttemptCount']) && gate.gateTaskId === target
        && nonNegative(gate.requestAttemptCount) && !!task && taskMatches(task, owner, target, 'gate')
        && waitMatches(wait, owner, stepId, target, 'any', scheduledTaskGraphAuditGateWaitKey(target, stepId, Number(gate.requestAttemptCount)), true)
    }
    if (!task) return false
    if (taskMatches(task, owner, target, 'audit') && positive(task.maxAttempts) && Number(task.maxAttempts) <= 32) {
      return Array.from({ length: Number(task.maxAttempts) }, (_, index) => index + 1)
        .some(attempt => waitMatches(wait, owner, stepId, target, 'all', scheduledTaskGraphAuditWaitKey(target, stepId, attempt), false))
    }
    return taskMatches(task, owner, target, 'prepare') && waitMatches(wait, owner, stepId, target,
      'all', String(wait.idempotencyKey), false) && typeof wait.idempotencyKey === 'string'
      && /^scheduled-prepare-dependency:[a-f0-9]{64}$/.test(wait.idempotencyKey)
  })
}
function waitMatches(wait: Row, owner: OwnerIdentity, stepId: string, target: string, mode: 'all' | 'any', key: string, gate: boolean): boolean {
  const ids = idsFrom(wait.targetTaskIds), matched = idsFrom(wait.matchedTaskIds), result = record(parse(wait.result)), request = record(result?.request)
  const outer = Object.keys(result ?? {}).sort().join(','), keys = gate ? ['mode', 'scheduledGate', 'targetTaskIds', 'timeoutMs'] : ['mode', 'targetTaskIds', 'timeoutMs']
  return validId(wait.id) && wait.userId === owner.userId && wait.sessionId === owner.sessionId && wait.turnId === owner.turnId
    && wait.parentTaskId === owner.rootTaskId && wait.stepId === stepId && wait.idempotencyKey === key
    && (wait.status === 'waiting' && matched?.length === 0 || wait.status === 'ready' && same(matched, [target]))
    && wait.mode === mode && same(ids, [target]) && (outer === 'request' || outer === 'outcome,request')
    && !!request && exactKeys(request, keys) && request.mode === mode && request.timeoutMs === WAIT_TIMEOUT_MS && same(request.targetTaskIds, [target])
}

function taskMatches(task: Row, owner: OwnerIdentity, id: string, kind: 'audit' | 'gate' | 'prepare'): boolean {
  const session = record(task.session), expected = kind === 'audit' ? ['auditor', 'scheduled_taskgraph_audit']
    : kind === 'gate' ? ['prepare', 'scheduled_taskgraph_gate'] : ['prepare', 'scheduled_application_prepare']
  return task.id === id && task.parentTaskId === owner.rootTaskId && task.rootTaskId === owner.rootTaskId && task.sessionId === owner.sessionId
    && task.turnId === owner.turnId && session?.userId === owner.userId && task.depth === 1 && task.role === expected[0] && task.taskType === expected[1]
}

function parseMarker(value: unknown): RecoveryMarker | null {
  const row = record(parse(value)), owner = record(row?.owner)
  if (!row || !owner || !exactKeys(row, ['schemaVersion', 'kind', 'owner', 'rootAttemptCount', 'sourceEventId', 'sourceStepId',
    'sourceStepOrdinal', 'sourceInputThroughSequence', 'recoveryStepId', 'recoveryCursor', 'predecessorStepId', 'inputThroughSequence'])
    || !exactKeys(owner, ['userId', 'sessionId', 'turnId', 'rootTaskId']) || row.schemaVersion !== MARKER_SCHEMA
    || row.kind !== 'scheduled_pipeline_recovery' || !validOwnerRecord(owner) || !positive(row.rootAttemptCount)
    || !validId(row.sourceEventId) || !validId(row.sourceStepId) || !nonNegative(row.sourceStepOrdinal)
    || !validCursor(row.sourceInputThroughSequence) || !validId(row.recoveryStepId) || !positive(row.recoveryCursor)
    || !validId(row.predecessorStepId) || !validCursor(row.inputThroughSequence)
    || BigInt(row.inputThroughSequence) < BigInt(row.sourceInputThroughSequence)) return null
  return { schemaVersion: MARKER_SCHEMA, kind: 'scheduled_pipeline_recovery', owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId },
    rootAttemptCount: row.rootAttemptCount, sourceEventId: row.sourceEventId, sourceStepId: row.sourceStepId,
    sourceStepOrdinal: row.sourceStepOrdinal, sourceInputThroughSequence: row.sourceInputThroughSequence,
    recoveryStepId: row.recoveryStepId, recoveryCursor: row.recoveryCursor, predecessorStepId: row.predecessorStepId,
    inputThroughSequence: row.inputThroughSequence }
}

function sameOwner(left: Row, right: ScheduledTaskGraphPipelineOwner, attempt: number): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === attempt && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function validOwner(owner: ScheduledTaskGraphPipelineOwner): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.executionId, owner.turnLeaseOwnerId].every(validId)
    && positive(owner.rootAttemptCount) && nonNegative(owner.turnLeaseVersion) && nonNegative(owner.executionAttemptCount)
}
function validOwnerRecord(value: Row): value is Row & OwnerIdentity { return [value.userId, value.sessionId, value.turnId, value.rootTaskId].every(validId) }
function record(value: unknown): Row | null { value = parse(value); if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : null } catch { return null } }
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function parse(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown } catch { return null } }
function idsFrom(value: unknown): string[] | null { const row = parse(value); return Array.isArray(row) && row.every(validId) && new Set(row).size === row.length ? row : null }
function cursorValue(value: unknown): string { value = typeof value === 'bigint' || typeof value === 'number' ? String(value) : value; return validCursor(value) ? value : '' }
function validCursor(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= BigInt('9223372036854775807') }
function validId(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function zero(value: unknown): boolean { return value === 0 || value === '0' }
function zeroCost(value: unknown): boolean { return value === 0 || typeof value === 'string' && /^0(?:\.0+)?$/.test(value) || value instanceof Prisma.Decimal && value.isZero() }
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]))
  const a = record(left), b = record(right)
  if (!a || !b) return false
  const keys = Object.keys(a).sort(), otherKeys = Object.keys(b).sort()
  return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && same(a[key], b[key])) }
