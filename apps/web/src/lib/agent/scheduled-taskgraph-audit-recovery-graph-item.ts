import { createHash } from 'node:crypto'
import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import type { Prisma } from '@prisma/client'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ScheduledGateRootWait } from './scheduled-taskgraph-gate-root-wait'

type Row = Record<string, unknown>
type GraphItem = Readonly<{ id: string; sessionId: string; turnId: string; stepId: string; taskId: string;
  type: string; status: string; phase: string | null; revision: number; content: unknown }>
const AUDIT_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const AUDIT_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
const WAIT_TIMEOUT_MS = 86_400_000

/** Recognizes only the exact server-written TaskGraph proposal owned by this recovery Step. */
export async function isScheduledTaskGraphAuditRecoveryGraphItem(input: Readonly<{
  reader: Prisma.TransactionClient
  owner: ScheduledTaskGraphPipelineOwner
  stepId: string
  item: unknown
}>): Promise<boolean> {
  return recoveryGraphItemProposalMatches(input)
}

/** Recognizes only a Gate-only proposal owned by this recovery Step and its scheduled Gate task. */
export async function isScheduledTaskGraphGateRecoveryGraphItem(input: Readonly<{
  reader: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner; stepId: string; gateTaskId: string; item: unknown
}>): Promise<boolean> {
  if (!validId(input.gateTaskId)) return false
  return recoveryGraphItemProposalMatches(input, input.gateTaskId)
}

/** Removes no more than one item, and only after its own persisted proposal receipt validates. */
export async function scheduledTaskGraphAuditRecoveryItems<T extends Row>(input: Readonly<{
  reader: Prisma.TransactionClient
  owner: ScheduledTaskGraphPipelineOwner
  stepId: string
  gateTaskId?: string
  items: readonly T[]
}>): Promise<T[]> {
  const graphItems = input.items.filter(item => item.type === 'task_graph')
  const graphItem = graphItems[0]
  if (graphItems.length !== 1 || !(input.gateTaskId
    ? await isScheduledTaskGraphGateRecoveryGraphItem({ reader: input.reader, owner: input.owner, stepId: input.stepId,
      gateTaskId: input.gateTaskId, item: graphItem })
    : await isScheduledTaskGraphAuditRecoveryGraphItem({ reader: input.reader, owner: input.owner, stepId: input.stepId, item: graphItem }))) return [...input.items]
  return input.items.filter(item => item !== graphItems[0])
}

/** Requires the same exact Gate wait that was locked with the Root/Turn witness. */
export function scheduledTaskGraphAuditGateWaitWitnessMatches(input: Readonly<{ owner: ScheduledTaskGraphPipelineOwner;
  witness: ScheduledGateRootWait; stepId: string; waits: readonly unknown[] }>): boolean {
  const { owner, witness, stepId, waits } = input, matches = waits.map(row).filter(wait => wait?.id === witness.waitId)
  const wait = matches[0], result = row(parse(wait?.result)), request = row(result?.request), marker = row(request?.scheduledGate)
  return exactKeys(witness as unknown as Row, ['waitId', 'stepId', 'requestAttemptCount', 'approvalIds', 'gateTaskId', 'owner', 'turn', 'root'])
    && exactKeys(witness.owner as unknown as Row, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount',
      'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'])
    && exactKeys(witness.turn as unknown as Row, ['id', 'status', 'leaseOwnerId', 'leaseVersion', 'leaseExpiresAt'])
    && exactKeys(witness.root as unknown as Row, ['id', 'status', 'attemptCount', 'waitId'])
    && validOwner(owner) && validId(stepId) && matches.length === 1 && witness.stepId === stepId
    && validId(witness.waitId) && validId(witness.gateTaskId) && nonNegative(witness.requestAttemptCount)
    && witness.requestAttemptCount < Number.MAX_SAFE_INTEGER
    && witness.owner.userId === owner.userId && witness.owner.sessionId === owner.sessionId
    && witness.owner.turnId === owner.turnId && witness.owner.rootTaskId === owner.rootTaskId
    && witness.owner.rootAttemptCount === owner.rootAttemptCount && witness.owner.turnLeaseOwnerId === owner.turnLeaseOwnerId
    && witness.owner.turnLeaseVersion === owner.turnLeaseVersion && witness.owner.executionId === owner.executionId
    && witness.owner.executionAttemptCount === owner.executionAttemptCount && witness.turn.id === owner.turnId
    && (witness.turn.status === 'waiting_for_dependency' ? Array.isArray(witness.approvalIds) && witness.approvalIds.length === 0
      : witness.turn.status === 'waiting_for_approval' && validApprovalIds(witness.approvalIds))
    && witness.turn.leaseOwnerId === null
    && witness.turn.leaseVersion === owner.turnLeaseVersion && witness.turn.leaseExpiresAt === null
    && witness.root.id === owner.rootTaskId && witness.root.status === 'waiting'
    && witness.root.attemptCount === owner.rootAttemptCount && witness.root.waitId === witness.waitId
    && wait?.userId === owner.userId && wait.sessionId === owner.sessionId && wait.turnId === owner.turnId
    && wait.parentTaskId === owner.rootTaskId && wait.stepId === stepId && wait.status === 'waiting'
    && wait.suspendedAt != null && wait.consumedAt === null && wait.mode === 'any'
    && same(parse(wait.targetTaskIds), [witness.gateTaskId]) && same(parse(wait.matchedTaskIds), [])
    && wait.idempotencyKey === scheduledTaskGraphAuditGateWaitKey(witness.gateTaskId, stepId, witness.requestAttemptCount)
    && !!result && exactKeys(result, ['request']) && !!request
    && exactKeys(request, ['targetTaskIds', 'mode', 'timeoutMs', 'scheduledGate'])
    && same(request.targetTaskIds, [witness.gateTaskId]) && request.mode === 'any' && request.timeoutMs === WAIT_TIMEOUT_MS
    && !!marker && exactKeys(marker, ['gateTaskId', 'requestAttemptCount'])
    && marker.gateTaskId === witness.gateTaskId && marker.requestAttemptCount === witness.requestAttemptCount
}

/** Stable Gate question identifiers are part of the same recovery-item contract. */
export function scheduledTaskGraphAuditGateQuestionId(binding: Readonly<{ owner: Row }>): string {
  return `agent-question:${binding.owner.turnId as string}:gate:${createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex')}`
}

export function scheduledTaskGraphAuditGateWaitKey(taskId: string, stepId: string, attempt: number): string {
  return `scheduled-gate-wait:${createHash('sha256').update(JSON.stringify([taskId, stepId, attempt]), 'utf8').digest('hex')}`
}

export function scheduledTaskGraphAuditWaitKey(taskId: string, stepId: string, attempt: number): string {
  return `scheduled-audit-wait:${createHash('sha256').update(JSON.stringify([taskId, stepId, attempt]), 'utf8').digest('hex')}`
}

export function scheduledTaskGraphAuditRecoveryEventIsActivity(type: unknown): boolean {
  return typeof type === 'string' && (type.startsWith('model.') || type.startsWith('tool_call.'))
}

async function recoveryGraphItemProposalMatches(input: Readonly<{ reader: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner;
  stepId: string; item: unknown }>, gateTaskId?: string): Promise<boolean> {
  const { reader, owner, stepId } = input
  try {
    const item = row(input.item)
    if (!item || !validId(stepId) || !validOwner(owner) || !validItem(item, owner, stepId)) return false
    const events = await reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: owner.rootTaskId, itemId: item.id, type: 'item.delta', actor: 'orchestrator', correlationId: owner.turnId,
      causationId: stepId, idempotencyKey: { startsWith: `${item.id}:proposal:` } }, take: 2,
    select: { id: true, sessionId: true, turnId: true, taskId: true, itemId: true, type: true, actor: true,
      correlationId: true, causationId: true, idempotencyKey: true, payload: true } })
    return events.length === 1 && proposalMatches(row(events[0]), item, owner, stepId, gateTaskId)
  } catch { return false }
}

function validItem(item: Row, owner: ScheduledTaskGraphPipelineOwner, stepId: string): item is Row & GraphItem {
  return exactKeys(item, ['id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'phase', 'revision', 'content'])
    && item.id === graphItemId(owner.rootTaskId) && item.sessionId === owner.sessionId && item.turnId === owner.turnId
    && item.stepId === stepId && item.taskId === owner.rootTaskId && item.type === 'task_graph'
    && item.status === 'streaming' && item.phase === null && positive(item.revision)
}

function proposalMatches(event: Row | null, item: GraphItem, owner: ScheduledTaskGraphPipelineOwner, stepId: string, gateTaskId?: string): boolean {
  const payload = row(event?.payload), dto = row(payload?.item), receipt = row(payload?.receipt)
  const revision = payload?.revision, content = row(payload?.content)
  if (!event || !payload || !dto || !receipt || !content
    || !exactKeys(event, ['id', 'sessionId', 'turnId', 'taskId', 'itemId', 'type', 'actor', 'correlationId', 'causationId', 'idempotencyKey', 'payload'])
    || event.sessionId !== owner.sessionId || event.turnId !== owner.turnId || event.taskId !== owner.rootTaskId
    || event.itemId !== item.id || event.type !== 'item.delta' || event.actor !== 'orchestrator'
    || event.correlationId !== owner.turnId || event.causationId !== stepId || !validId(event.id)
    || !positive(revision) || item.revision < revision || payload.kind !== 'proposal'
    || !hex(payload.fingerprint) || !exactKeys(payload, ['kind', 'fingerprint', 'receipt', 'revision', 'item', 'content'])
    || event.idempotencyKey !== `${item.id}:proposal:${revision - 1}`
    || !dtoMatches(dto, item, revision, content) || !same(item.content, content)) return false
  return gateTaskId ? gateReceiptMatches(receipt, revision, content, owner.rootTaskId, gateTaskId)
    : receiptMatches(receipt, revision, content, owner.rootTaskId)
}

function gateReceiptMatches(receipt: Row, revision: number, value: Row, rootTaskId: string, gateTaskId: string): boolean {
  const receiptNodes = Array.isArray(receipt.nodes) ? receipt.nodes.map(row) : [], ready = Array.isArray(receipt.readyTaskIds) ? receipt.readyTaskIds : []
  const contentKeys = Object.hasOwn(value, 'rootSuccessCriteria') ? ['nodes', 'rootSuccessCriteria', 'schemaVersion'] : ['nodes', 'schemaVersion']
  const nodes = Array.isArray(value.nodes) ? value.nodes.map(row) : [], scoutCount = nodes.length - 3
  const keys = nodes.map(node => node?.key), taskIds = nodes.map(node => node?.taskId), templates = nodes.map(node => node?.templateId)
  const depths = nodes.map(node => node?.depth), scouts = nodes.slice(0, scoutCount), analyst = nodes[scoutCount]
  const prepare = nodes[scoutCount + 1], gate = nodes[scoutCount + 2]
  if (!exactKeys(receipt, ['status', 'revision', 'nodes', 'readyTaskIds']) || receipt.status !== 'accepted' || receipt.revision !== revision
    || receiptNodes.length !== 1 || !receiptNodes[0] || !exactKeys(receiptNodes[0], ['key', 'taskId', 'status'])
    || receiptNodes[0].key !== 'gate' || receiptNodes[0].taskId !== gateTaskId || receiptNodes[0].status !== 'queued'
    || !same(ready, [gateTaskId]) || value.schemaVersion !== 'agent-harness.v2.task-graph' || !exactKeys(value, contentKeys)
    || scoutCount < 1 || scoutCount > 4 || nodes.some(node => !node) || keys.some(key => !validNodeKey(key))
    || new Set(keys).size !== nodes.length || taskIds.some(id => !validId(id) || id === rootTaskId)
    || new Set(taskIds).size !== nodes.length || !same(templates, [...Array(scoutCount).fill('scout'), 'analyst', 'prepare', 'gate'])
    || !same(depths, [...Array(scoutCount).fill(1), 2, 3, 4])) return false
  const sourceKeys = keys.slice(0, scoutCount)
  return scouts.every(node => node?.verificationDisposition === 'typed' && same(node.dependsOn, []))
    && !!analyst && analyst.verificationDisposition === 'typed' && sameSet(analyst.dependsOn, sourceKeys)
    && !!prepare && prepare.verificationDisposition === 'specialized' && same(prepare.dependsOn, [analyst.key])
    && !!gate && exactKeys(gate, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    && gate.key === 'gate' && gate.templateId === 'gate' && gate.taskId === gateTaskId
    && gate.verificationDisposition === 'specialized' && same(gate.dependsOn, ['prepare'])
}

function dtoMatches(dto: Row, item: GraphItem, revision: number, content: Row): boolean {
  return exactKeys(dto, ['schemaVersion', 'id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'phase', 'revision',
    'content', 'startedAt', 'completedAt', 'createdAt', 'updatedAt'])
    && dto.schemaVersion === AGENT_STREAM_SCHEMA_VERSION && dto.id === item.id && dto.sessionId === item.sessionId
    && dto.turnId === item.turnId && dto.stepId === item.stepId && dto.taskId === item.taskId && dto.type === item.type
    && dto.status === item.status && dto.phase === item.phase && dto.revision === revision && same(dto.content, content)
    && iso(dto.startedAt) && dto.completedAt === null && iso(dto.createdAt) && iso(dto.updatedAt)
}

function receiptMatches(receipt: Row, revision: number, snapshot: Row, rootTaskId: string): boolean {
  const nodes = Array.isArray(receipt.nodes) ? receipt.nodes : [], node = row(nodes[0])
  const ready = Array.isArray(receipt.readyTaskIds) ? receipt.readyTaskIds : []
  const graph = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
  const graphNodes = graph.map(row), taskIds = graphNodes.map(value => value?.taskId), scoutCount = graph.length - 4
  const graphKeys = graphNodes.map(value => value?.key)
  const templates = graphNodes.map(value => value?.templateId)
  const depths = graphNodes.map(value => value?.depth)
  const scouts = graphNodes.slice(0, scoutCount), sourceKeys = scouts.map(value => value?.key)
  const analyst = graphNodes[scoutCount], prepare = graphNodes[scoutCount + 1], gate = graphNodes[scoutCount + 2], audit = graphNodes[scoutCount + 3]
  if (!exactKeys(receipt, ['status', 'revision', 'nodes', 'readyTaskIds']) || receipt.status !== 'accepted'
    || receipt.revision !== revision || nodes.length !== 1 || !node
    || !exactKeys(node, ['key', 'taskId', 'status']) || node.key !== 'scheduled_audit'
    || !validId(node.taskId) || node.taskId === rootTaskId || node.status !== 'queued'
    || ready.length !== 1 || ready[0] !== node.taskId || snapshot.schemaVersion !== 'agent-harness.v2.task-graph'
    || !exactKeys(snapshot, Object.hasOwn(snapshot, 'rootSuccessCriteria')
      ? ['nodes', 'rootSuccessCriteria', 'schemaVersion'] : ['nodes', 'schemaVersion'])
    || !(scoutCount === 1 || scoutCount >= 2 && scoutCount <= 4) || graphNodes.some(value => !value)
    || taskIds.some(id => !validId(id) || id === rootTaskId) || new Set(taskIds).size !== graph.length
    || graphKeys.some(key => !validNodeKey(key)) || new Set(graphKeys).size !== graph.length
    || !same(templates, [...Array(scoutCount).fill('scout'), 'analyst', 'prepare', 'gate', 'scheduled_audit'])
    || !same(graphKeys.slice(scoutCount + 1), ['prepare', 'gate', 'scheduled_audit'])
    || !same(depths, [...Array(scoutCount).fill(1), 2, 3, 4, 5])
    || scouts.some(scout => !scout || !same(scout.dependsOn, []) || scout.verificationDisposition !== 'typed')
    || !analyst || !prepare || !gate || !sameSet(analyst.dependsOn, sourceKeys)
    || !same(prepare.dependsOn, [analyst.key]) || !same(gate.dependsOn, [prepare.key])
    || !audit || !exactKeys(audit, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    || audit.key !== 'scheduled_audit' || audit.templateId !== 'scheduled_audit' || audit.depth !== 5
    || audit.taskId !== node.taskId || audit.verificationDisposition !== 'specialized'
    || !same(audit.goal, AUDIT_GOAL) || !same(audit.successCriteria, AUDIT_CRITERIA) || !same(audit.dependsOn, ['gate'])) return false
  return true
}

function sameSet(actual: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every(value => actual.includes(value))
}

function validOwner(owner: ScheduledTaskGraphPipelineOwner): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.executionId, owner.turnLeaseOwnerId].every(validId)
    && positive(owner.rootAttemptCount) && nonNegative(owner.turnLeaseVersion) && nonNegative(owner.executionAttemptCount)
}
function graphItemId(rootTaskId: string): string { return `task-graph-${createHash('sha256').update(rootTaskId).digest('hex')}` }
function row(value: unknown): Row | null {
  value = parse(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : null } catch { return null }
}
function parse(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown } catch { return null } }
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]))
  const a = row(left), b = row(right)
  if (!a || !b) return false
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort()
  return keys.length === other.length && keys.every((key, index) => key === other[index] && same(a[key], b[key]))
}
function validApprovalIds(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 || !value.every(validId)) return false
  const ids = value as string[]
  return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]! < id)
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function validNodeKey(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function hex(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function iso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
