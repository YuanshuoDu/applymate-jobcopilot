import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { parseScheduledTaskGraphGateResult } from './scheduled-taskgraph-gate-service'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ParsedScheduledTaskGraphPrepareProof } from './scheduled-taskgraph-gate-checkpoint'
export { scheduledTaskGraphGateBindingIsCurrent } from './scheduled-taskgraph-prepare-proof'

const MAX_EVENTS = 256
const GRAPH_SCHEMA = 'agent-harness.v2.task-graph'
const RESULT_SCHEMA = 'agent-harness.v2.subagent.result'
const GATE_TYPE = 'scheduled_taskgraph_gate'
const GATE_SCHEMA = { schemaVersion: RESULT_SCHEMA, role: 'prepare', taskType: GATE_TYPE }
const AUDIT_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const AUDIT_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
const AUDIT_SCHEMA = { schemaVersion: RESULT_SCHEMA, role: 'auditor', taskType: 'scheduled_taskgraph_audit' }

export type ScheduledTaskGraphGateHistoryInput = Readonly<{
  reader: Prisma.TransactionClient
  owner: ScheduledTaskGraphPipelineOwner
  prepareTaskId: string
  prepareGraphRevision: number
  prepareAttemptCount: number
  graphRevision: number
  graphContent: unknown
  gateTask: Readonly<{ id: string; status: string; attemptCount: number; maxAttempts: number; result: unknown }>
  gate: Readonly<{ taskId: string; attemptCount: number; phase: 'running' | 'completed'; completionProof?: unknown }>
  auditTask?: Readonly<{ id: string; status: string; attemptCount: number }>
  expectedJobIds: readonly string[]
}>

/** Proves the immutable Prepare prefix, the sole Gate proposal, and every Gate transition from durable receipts. */
export async function scheduledTaskGraphGateHistoryIsCurrent(input: ScheduledTaskGraphGateHistoryInput): Promise<boolean> {
  try {
    const graphId = taskGraphItemId(input.owner.rootTaskId)
    if (!validId(input.prepareTaskId)) return false
    const prepareKey = lifecycleKey(input.owner.rootTaskId, 'prepare', input.prepareAttemptCount, 'task.completed')
    const prepareRows = await input.reader.agentEvent.findMany({
      where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, itemId: graphId,
        type: 'item.delta', idempotencyKey: prepareKey },
      orderBy: { sequence: 'asc' }, take: 2,
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
        idempotencyKey: true, sequence: true, payload: true },
    })
    if (prepareRows.length !== 1) return false
    const prepare = parseLifecycle(prepareRows[0], { owner: input.owner, graphId, expectedRevision: input.prepareGraphRevision - 1,
      nodeKey: 'prepare', taskId: input.prepareTaskId, attempt: input.prepareAttemptCount, type: 'task.completed' })
    if (!prepare) return false
    const priorSnapshot = snapshot(prepare.content)
    if (!priorSnapshot || priorSnapshot.nodes.length < 3 || priorSnapshot.nodes.length > 6
      || taskNodeTaskId(priorSnapshot, 'prepare') !== input.prepareTaskId) return false
    const prepareSequence = BigInt(String(prepare.row.sequence))
    const later = await input.reader.agentEvent.findMany({
      where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, itemId: graphId,
        type: 'item.delta', sequence: { gt: prepareSequence } },
      orderBy: { sequence: 'asc' }, take: MAX_EVENTS,
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
        idempotencyKey: true, sequence: true, payload: true },
    })
    if (later.length < 2 || later.length >= MAX_EVENTS) return false
    return await validateHistory(input, graphId, priorSnapshot, later)
  } catch { return false }
}

async function validateHistory(input: ScheduledTaskGraphGateHistoryInput, graphId: string, prior: Snapshot, rows: readonly unknown[]): Promise<boolean> {
  const prepareNodeCount = prior.nodes.length
  const proposal = record(rows[0]), proposalPayload = record(proposal?.payload), proposalRevision = input.prepareGraphRevision + 1
  const proposalKey = `${graphId}:proposal:${input.prepareGraphRevision}`
  if (!proposal || proposal.type !== 'item.delta' || proposal.actor !== 'orchestrator' || proposal.idempotencyKey !== proposalKey
    || proposal.itemId !== graphId || proposal.taskId !== input.owner.rootTaskId || proposal.sessionId !== input.owner.sessionId
    || proposal.turnId !== input.owner.turnId || !proposalPayload || proposalPayload.kind !== 'proposal'
    || proposalPayload.revision !== proposalRevision || !isHex(proposalPayload.fingerprint)) return false
  const receipt = record(proposalPayload.receipt), receiptNodes = denseArray(receipt?.nodes)
  const proposedSnapshot = snapshot(proposalPayload.content)
  const currentSnapshot = snapshot(input.graphContent), hasAudit = currentSnapshot?.nodes.length === prepareNodeCount + 2
  if (!receipt || receipt.status !== 'accepted' || receipt.revision !== proposalRevision || !receiptNodes || receiptNodes.length !== 1
    || record(receiptNodes[0])?.key !== 'gate' || record(receiptNodes[0])?.taskId !== input.gate.taskId
    || record(receiptNodes[0])?.status !== 'queued' || !sameStrings(receipt?.readyTaskIds, [input.gate.taskId])
    || !proposedSnapshot || proposedSnapshot.nodes.length !== prepareNodeCount + 1 || !samePrefix(prior, proposedSnapshot, prepareNodeCount)
    || !currentSnapshot || currentSnapshot.nodes.length !== (hasAudit ? prepareNodeCount + 2 : prepareNodeCount + 1)
    || hasAudit && (input.gate.phase !== 'completed' || !input.auditTask
      || !validAuditNode(currentSnapshot.nodes[prepareNodeCount + 1]!, input.auditTask.id))
    || input.graphRevision < proposalRevision) return false
  const gateNode = proposedSnapshot.nodes[prepareNodeCount]!
  if (!validGateNode(gateNode, input.gate.taskId)) return false

  if (!Number.isSafeInteger(input.gateTask.maxAttempts) || input.gateTask.maxAttempts < 1) return false
  let revision = proposalRevision, attempt = 1, status: 'queued' | 'running' | 'waiting_for_user' | 'completed' = 'queued'
  let currentContent: Snapshot = proposedSnapshot
  const lifecycleRows = rows.slice(1)
  if (!lifecycleRows.length) return false
  const completedIndex = hasAudit ? lifecycleRows.findIndex(raw => {
    const event = record(record(record(raw)?.payload)?.event)
    return event?.nodeKey === 'gate' && event.type === 'task.completed'
  }) : lifecycleRows.length - 1
  if (hasAudit && completedIndex < 0) return false
  for (const raw of lifecycleRows.slice(0, completedIndex + 1)) {
    const payload = record(record(raw)?.payload), event = record(payload?.event)
    if (!event || event.nodeKey !== 'gate' || payload?.kind !== 'lifecycle') return false
    const type = event.type
    if (type !== 'task.started' && type !== 'task.waiting_for_user' && type !== 'task.gate_choice_resumed'
      && type !== 'task.retrying' && type !== 'task.completed') return false
    const next = parseLifecycle(raw, { owner: input.owner, graphId, expectedRevision: revision,
      nodeKey: 'gate', taskId: input.gate.taskId, attempt, type, gateTaskId: input.gate.taskId })
    if (!next) return false
    revision += 1
    if (type === 'task.started' && status === 'queued') status = 'running'
    else if (type === 'task.waiting_for_user' && status === 'running') status = 'waiting_for_user'
    else if (type === 'task.gate_choice_resumed' && status === 'waiting_for_user') { attempt += 1; status = 'queued' }
    else if (type === 'task.retrying' && status === 'running' && attempt < input.gateTask.maxAttempts) { attempt += 1; status = 'queued' }
    else if (type === 'task.completed' && status === 'running') status = 'completed'
    else return false
    const nextContent = snapshot(next.content)
    if (!nextContent || !sameJson(nextContent, proposedSnapshot)) return false
    currentContent = nextContent
  }
  const currentPrefix = hasAudit ? { ...currentSnapshot!, nodes: currentSnapshot!.nodes.slice(0, prepareNodeCount + 1) } : currentSnapshot!
  if ((hasAudit ? input.graphRevision <= revision : revision !== input.graphRevision)
    || input.gateTask.status !== status || input.gateTask.attemptCount !== input.gate.attemptCount
    || attempt !== input.gate.attemptCount || !sameJson(currentContent, currentPrefix)) return false
  if (input.gate.phase === 'running') return status === 'running' && input.gateTask.status === 'running'
  if (status !== 'completed' || !validCompletedGate(input, revision)) return false
  return !hasAudit || await validAuditTaskRow(input, currentSnapshot!.nodes[prepareNodeCount + 1]!, revision)
}

function validAuditNode(node: Record<string, unknown>, taskId: string): boolean {
  return Boolean(exactRecord(node, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    && node.key === 'scheduled_audit' && node.templateId === 'scheduled_audit' && node.taskId === taskId && node.depth === 5
    && node.goal === AUDIT_GOAL && sameJson(node.successCriteria, AUDIT_CRITERIA) && node.verificationDisposition === 'specialized'
    && sameStrings(node.dependsOn, ['gate']))
}

async function validAuditTaskRow(input: ScheduledTaskGraphGateHistoryInput, node: Record<string, unknown>, gateRevision: number): Promise<boolean> {
  const expected = input.auditTask
  if (!expected || !validAuditNode(node, expected.id)) return false
  const task = await input.reader.subAgentTask.findFirst({ where: { id: expected.id, sessionId: input.owner.sessionId,
    turnId: input.owner.turnId, rootTaskId: input.owner.rootTaskId, parentTaskId: input.owner.rootTaskId,
    session: { is: { userId: input.owner.userId } } }, select: { id: true, sessionId: true, turnId: true, rootTaskId: true,
    parentTaskId: true, depth: true, status: true, role: true, taskType: true, attemptCount: true, maxAttempts: true, failureReason: true,
    expectedOutputSchema: true, allowedActions: true } })
  return Boolean(task && input.graphRevision > gateRevision && task.id === expected.id && task.sessionId === input.owner.sessionId
    && task.turnId === input.owner.turnId && task.rootTaskId === input.owner.rootTaskId && task.parentTaskId === input.owner.rootTaskId && task.depth === 1
    && task.status === expected.status && task.attemptCount === expected.attemptCount
    && (task.status === 'queued' || task.status === 'running' || task.status === 'retrying' || task.status === 'completed')
    && Number.isSafeInteger(task.attemptCount) && (task.status === 'queued' ? task.attemptCount >= 0 : task.attemptCount > 0)
    && Number.isSafeInteger(task.maxAttempts) && task.maxAttempts > 0 && task.failureReason === null
    && task.role === 'auditor' && task.taskType === 'scheduled_taskgraph_audit'
    && sameJson(task.expectedOutputSchema, AUDIT_SCHEMA) && sameJson(task.allowedActions, []))
}

function validCompletedGate(input: ScheduledTaskGraphGateHistoryInput, revision: number): boolean {
  const proof = record(input.gate.completionProof), gateProof = record(proof?.gate), result = record(input.gateTask.result)
  if (!proof || !gateProof || proof.schemaVersion !== 'agent-harness.v2.scheduled-taskgraph-gate-completion.v1'
    || proof.graphRevision !== revision || !record(proof.prepareProof) || gateProof.taskId !== input.gate.taskId
    || gateProof.attemptCount !== input.gate.attemptCount || gateProof.completedEventRevision !== revision
    || gateProof.resultDigest !== digest(input.gateTask.result) || !result
    || Object.keys(result).sort().join(',') !== 'finalItemId,finalText,status,stepCount,structuredResult,taskGraphVerificationReport,toolCallCount'
    || result.finalItemId !== null || result.finalText !== '' || result.status !== 'completed'
    || result.stepCount !== 0 || result.toolCallCount !== 0 || result.taskGraphVerificationReport !== null) return false
  return parseScheduledTaskGraphGateResult(result.structuredResult, input.expectedJobIds)?.status === 'completed'
}

function parseLifecycle(value: unknown, expected: { owner: ScheduledTaskGraphPipelineOwner; graphId: string; expectedRevision: number;
  nodeKey: string; taskId: string; attempt: number; type: string; gateTaskId?: string }) {
  const row = record(value), payload = record(row?.payload), event = record(payload?.event), revision = payload?.revision
  if (!row || row.type !== 'item.delta' || row.actor !== 'system' || row.itemId !== expected.graphId
    || row.taskId !== expected.taskId || row.sessionId !== expected.owner.sessionId || row.turnId !== expected.owner.turnId
    || payload?.kind !== 'lifecycle' || !event || event.type !== expected.type || event.nodeKey !== expected.nodeKey
    || event.expectedRevision !== expected.expectedRevision || payload.revision !== expected.expectedRevision + 1
    || event.idempotencyKey !== lifecycleKey(expected.owner.rootTaskId, expected.nodeKey, expected.attempt, expected.type)
    || row.idempotencyKey !== event.idempotencyKey || !validItem(payload.item, expected.graphId, expected.owner, revision)) return null
  if (expected.type === 'task.gate_choice_resumed') {
    if (!exactKeys(event, ['type', 'idempotencyKey', 'expectedRevision', 'nodeKey', 'gateTaskId', 'requestAttemptCount', 'resumedAttemptCount'])
      || event.gateTaskId !== expected.gateTaskId || event.requestAttemptCount !== expected.attempt
      || event.resumedAttemptCount !== expected.attempt + 1) return null
  } else if (!exactKeys(event, ['type', 'idempotencyKey', 'expectedRevision', 'nodeKey'])) return null
  return { row, payload, content: record(payload.item)?.content as unknown, event }
}

type Snapshot = { schemaVersion: string; nodes: Record<string, unknown>[]; rootSuccessCriteria?: unknown }
function snapshot(value: unknown): Snapshot | null {
  const row = record(value), nodes = denseArray(row?.nodes)?.map(record)
  return row?.schemaVersion === GRAPH_SCHEMA && nodes && nodes.every(Boolean)
    ? { schemaVersion: GRAPH_SCHEMA, nodes: nodes as Record<string, unknown>[], ...(Object.hasOwn(row, 'rootSuccessCriteria') ? { rootSuccessCriteria: row.rootSuccessCriteria } : {}) }
    : null
}
function taskNodeTaskId(value: Snapshot, key: string): string | null {
  const matches = value.nodes.filter(node => node.key === key)
  const taskId = matches.length === 1 ? matches[0]?.taskId : null
  return validId(taskId) ? taskId : null
}
function samePrefix(prior: Snapshot, proposed: Snapshot, prepareNodeCount: number): boolean {
  if (prior.nodes.length !== prepareNodeCount || proposed.nodes.length !== prepareNodeCount + 1) return false
  return sameJson({ ...prior, nodes: prior.nodes }, { ...proposed, nodes: proposed.nodes.slice(0, prepareNodeCount) })
}
function validGateNode(node: Record<string, unknown>, taskId: string): boolean {
  return node.key === 'gate' && node.templateId === 'gate' && node.taskId === taskId && node.depth === 4
    && sameStrings(node.dependsOn, ['prepare']) && node.verificationDisposition === 'specialized'
    && !Object.hasOwn(node, 'verification') && !Object.hasOwn(node, 'repairOf') && !Object.hasOwn(node, 'nativeDelegation')
}
function validItem(value: unknown, graphId: string, owner: ScheduledTaskGraphPipelineOwner, revision: unknown): boolean {
  const item = record(value)
  return Boolean(item && item.id === graphId && item.sessionId === owner.sessionId && item.turnId === owner.turnId
    && item.taskId === owner.rootTaskId && item.type === 'task_graph' && item.revision === revision)
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}
function lifecycleKey(rootTaskId: string, nodeKey: string, attempt: number, type: string): string {
  const node = createHash('sha256').update(nodeKey).digest('hex').slice(0, 20)
  return `${taskGraphItemId(rootTaskId)}:node:${node}:${attempt}:${type}`
}
function taskGraphItemId(rootTaskId: string): string { return `task-graph-${createHash('sha256').update(rootTaskId).digest('hex')}` }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('invalid_gate_history_json')
  return encoded
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  return row && exactKeys(row, keys) ? row : null
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
}
function denseArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function isHex(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
