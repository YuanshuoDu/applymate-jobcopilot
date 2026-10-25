import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { parseScheduledTaskGraphGateResult } from './scheduled-taskgraph-gate-service'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ParsedScheduledTaskGraphPrepareProof } from './scheduled-taskgraph-gate-checkpoint'

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

type GatePhase = Readonly<{ taskId: string; attemptCount: number; phase: 'running' | 'completed'; completionProof?: unknown }>

/** Binds the one registered Gate to its exact private, ready Prepare dependency wait. */
export async function scheduledTaskGraphGateBindingIsCurrent(input: Readonly<{
  reader: Prisma.TransactionClient
  owner: ScheduledTaskGraphPipelineOwner
  marker: Record<string, unknown>
  checkpointDigest: string
  proof: ParsedScheduledTaskGraphPrepareProof
  gate: GatePhase
}>): Promise<boolean> {
  const { reader, owner, marker, checkpointDigest, proof, gate } = input
  const eventRows = await reader.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = ${owner.sessionId} AND event."turnId" = ${owner.turnId}
      AND event."type" = 'agent.plan.scheduled_gate_binding' AND session."userId" = ${owner.userId}
      AND turn."userId" = ${owner.userId} AND turn."rootTaskId" = ${owner.rootTaskId}
    ORDER BY event."sequence" ASC LIMIT 2 FOR UPDATE OF event
  `)
  const event = eventRows[0], receipt = exactRecord(event?.payload, ['schemaVersion', 'owner', 'continuationKey', 'snapshotDigest',
    'evidenceDigest', 'checkpointDigest', 'analyzeGraphRevision', 'prepareScheduleRevision', 'prepareWaitId', 'gateTaskId', 'gateAppendRevision'])
  const stableOwner = exactRecord(receipt?.owner, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount'])
  const eventKey = receipt && `scheduled-gate-binding:${createHash('sha256').update(JSON.stringify([receipt.continuationKey, gate.taskId]), 'utf8').digest('hex')}`
  if (eventRows.length !== 1 || !event || event.itemId !== null || event.taskId !== null || event.actor !== 'system' || event.hasOutbox !== false
    || !receipt || !stableOwner || event.idempotencyKey !== eventKey || receipt.schemaVersion !== 'agent-harness.v2.scheduled-taskgraph-gate-binding.v1'
    || !['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
      .every(key => stableOwner[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
    || receipt.continuationKey !== proof.receipt.continuationKey || receipt.snapshotDigest !== marker.snapshotDigest
    || receipt.evidenceDigest !== marker.evidenceDigest || receipt.checkpointDigest !== checkpointDigest
    || receipt.analyzeGraphRevision !== marker.graphRevision || receipt.prepareScheduleRevision !== proof.receipt.prepareScheduleRevision
    || receipt.prepareWaitId !== record(proof.completion.wait)?.waitId || receipt.gateTaskId !== gate.taskId
    || receipt.gateAppendRevision !== proof.graphRevision + 1 || !validId(receipt.prepareWaitId)) return false
  const waits = await reader.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey",
      wait."targetTaskIds", wait."mode", wait."status", wait."matchedTaskIds", wait."result",
      step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt"
    FROM "agent_wait_conditions" AS wait JOIN "agent_sessions" AS session ON session."id" = wait."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
      JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    WHERE wait."id" = ${receipt.prepareWaitId} AND wait."userId" = ${owner.userId} AND wait."sessionId" = ${owner.sessionId}
      AND wait."turnId" = ${owner.turnId} AND wait."parentTaskId" = ${owner.rootTaskId}
      AND session."userId" = ${owner.userId} AND turn."userId" = ${owner.userId}
    FOR UPDATE OF wait, step
  `)
  const wait = waits[0], request = record(record(wait?.result)?.request), stepId = wait?.stepId
  const waitKey = typeof stepId === 'string' && typeof marker.key === 'string'
    ? `scheduled-prepare-dependency:${createHash('sha256').update(`${marker.key}\0${stepId}`, 'utf8').digest('hex')}` : ''
  return waits.length === 1 && wait?.id === receipt.prepareWaitId && validId(stepId) && wait.idempotencyKey === waitKey
    && (wait.stepTaskId === null || wait.stepTaskId === owner.rootTaskId) && wait.stepAttempt === 1 && wait.mode === 'all'
    && wait.status === 'ready' && sameStrings(wait.targetTaskIds, [proof.result.taskId]) && sameStrings(wait.matchedTaskIds, [proof.result.taskId])
    && request !== null && exactKeys(request, ['targetTaskIds', 'mode', 'timeoutMs']) && request.mode === 'all'
    && request.timeoutMs === 86_400_000 && sameStrings(request.targetTaskIds, [proof.result.taskId])
}

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
    if (!priorSnapshot || priorSnapshot.nodes.length !== 3 || taskNodeTaskId(priorSnapshot, 'prepare') !== input.prepareTaskId) return false
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
  const proposal = record(rows[0]), proposalPayload = record(proposal?.payload), proposalRevision = input.prepareGraphRevision + 1
  const proposalKey = `${graphId}:proposal:${input.prepareGraphRevision}`
  if (!proposal || proposal.type !== 'item.delta' || proposal.actor !== 'orchestrator' || proposal.idempotencyKey !== proposalKey
    || proposal.itemId !== graphId || proposal.taskId !== input.owner.rootTaskId || proposal.sessionId !== input.owner.sessionId
    || proposal.turnId !== input.owner.turnId || !proposalPayload || proposalPayload.kind !== 'proposal'
    || proposalPayload.revision !== proposalRevision || !isHex(proposalPayload.fingerprint)) return false
  const receipt = record(proposalPayload.receipt), receiptNodes = denseArray(receipt?.nodes)
  const proposedSnapshot = snapshot(proposalPayload.content)
  const currentSnapshot = snapshot(input.graphContent), hasAudit = currentSnapshot?.nodes.length === 5
  if (!receipt || receipt.status !== 'accepted' || receipt.revision !== proposalRevision || !receiptNodes || receiptNodes.length !== 1
    || record(receiptNodes[0])?.key !== 'gate' || record(receiptNodes[0])?.taskId !== input.gate.taskId
    || record(receiptNodes[0])?.status !== 'queued' || !sameStrings(receipt?.readyTaskIds, [input.gate.taskId])
    || !proposedSnapshot || proposedSnapshot.nodes.length !== 4 || !samePrefix(prior, proposedSnapshot)
    || !currentSnapshot || currentSnapshot.nodes.length !== (hasAudit ? 5 : 4)
    || hasAudit && (input.gate.phase !== 'completed' || !input.auditTask
      || !validAuditNode(currentSnapshot.nodes[4]!, input.auditTask.id))
    || input.graphRevision < proposalRevision) return false
  const gateNode = proposedSnapshot.nodes[3]!
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
  const currentPrefix = hasAudit ? { ...currentSnapshot!, nodes: currentSnapshot!.nodes.slice(0, 4) } : currentSnapshot!
  if ((hasAudit ? input.graphRevision <= revision : revision !== input.graphRevision)
    || input.gateTask.status !== status || input.gateTask.attemptCount !== input.gate.attemptCount
    || attempt !== input.gate.attemptCount || !sameJson(currentContent, currentPrefix)) return false
  if (input.gate.phase === 'running') return status === 'running' && input.gateTask.status === 'running'
  if (status !== 'completed' || !validCompletedGate(input, revision)) return false
  return !hasAudit || await validAuditTaskRow(input, currentSnapshot!.nodes[4]!, revision)
}

function validAuditNode(node: Record<string, unknown>, taskId: string): boolean {
  return Boolean(exactRecord(node, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    && node.key === 'scheduled_audit' && node.templateId === 'scheduled_audit' && node.taskId === taskId && node.depth === 5
    && node.goal === AUDIT_GOAL && sameJson(node.successCriteria, AUDIT_CRITERIA) && node.verificationDisposition === 'legacy_unverified'
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
function samePrefix(prior: Snapshot, proposed: Snapshot): boolean {
  if (prior.nodes.length !== 3 || proposed.nodes.length !== 4) return false
  return sameJson({ ...prior, nodes: prior.nodes }, { ...proposed, nodes: proposed.nodes.slice(0, 3) })
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
