import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { scheduledTaskGraphExecuteGateCompletionProof } from './scheduled-taskgraph-gate-rpc'
import { parseScheduledTaskGraphGateResult } from './scheduled-taskgraph-gate-service'
import { lockScheduledTaskGraphPostGateChildFence, type ScheduledTaskGraphPostGateActor } from './scheduled-taskgraph-audit-child-fence'
import { parseScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-prepare-proof'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const HANDOFF_TYPE = 'agent.plan.scheduled_post_gate_handoff'
const HANDOFF_SCHEMA = 'agent-harness.v2.scheduled-post-gate-handoff.v1'
const EXECUTE_TEMPLATE = 'scheduled.application.execute'
const AUDIT_TEMPLATE = 'scheduled.post_gate_audit'
const EXECUTE_GOAL = 'Run the existing Execute stage once for only this exact Gate-approved package partition; do not submit applications.'
const EXECUTE_CRITERIA = ['Use only the exact Gate-approved package refs attached to this server-owned Execute task.',
  'Run the existing non-submitting Execute behavior and return its bounded result.',
  'Do not submit applications, send Gmail, contact employers, or create child tasks.']
const AUDIT_GOAL = 'Return the existing scheduled Audit report after every server-planned Execute task is terminal.'
const AUDIT_CRITERIA = ['Run the existing scheduled Audit behavior exactly once after all Execute dependencies finish.',
  'Preserve the existing seven-field report semantics and return only the bounded report.',
  'Do not submit applications, send Gmail, contact employers, or invoke model or tool runtimes.']
const EXECUTE_SCHEMA = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'executor', taskType: 'scheduled_taskgraph_execute' }
const AUDIT_SCHEMA = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'auditor', taskType: 'scheduled_taskgraph_post_gate_audit' }
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/

export type ScheduledPostGateHandoff = Readonly<Record<string, unknown> & {
  owner: ScheduledTaskGraphPipelineOwner; gateTaskId: string; gateAttemptCount: number; gateCompletedEventRevision: number
  gateGraphRevision: number; graphRevision: number
  packageRefs: readonly string[]; executeNodes: readonly Readonly<{ key: string; taskId: string; packageRefs: readonly string[] }>[]; auditTaskId: string
}>
export type ScheduledTaskGraphPostGateProofInput = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner; actor: ScheduledTaskGraphPostGateActor; handoff: unknown; prepareProof: unknown
  packageRefs?: readonly string[]; actorFenceLocked?: boolean
  gate: Readonly<{ taskId: string; attemptCount: number; phase: 'completed'; completionProof: unknown }>
  graph: Readonly<{ id: string; revision: number; content: unknown }>; tasks: readonly unknown[]
}>

/** Validates the immutable Worker handoff, its accepted TaskGraph suffix, Gate proof, and current child lease. */
export async function scheduledTaskGraphPostGateProofIsCurrent(tx: Prisma.TransactionClient,
  input: ScheduledTaskGraphPostGateProofInput): Promise<boolean> {
  try {
    const receipt = parseScheduledPostGateHandoff(input.handoff), owner = parseScheduledTaskGraphPipelineOwner(input.owner)
    const gateProof = scheduledTaskGraphExecuteGateCompletionProof(receipt?.gateProof)
    if (!receipt || !owner || !gateProof || !sameOwner(receipt.owner, owner) || !sameJson(gateProof, input.gate.completionProof)
      || !sameJson(gateProof.prepareProof, input.prepareProof) || input.gate.taskId !== receipt.gateTaskId
      || input.gate.attemptCount !== receipt.gateAttemptCount || input.gate.phase !== 'completed'
      || receipt.gateGraphRevision !== gateProof.graphRevision || receipt.gateCompletedEventRevision !== gateProof.graphRevision
      || !input.actorFenceLocked && !await lockScheduledTaskGraphPostGateChildFence(tx, { owner, actor: input.actor })) return false
    const graph = record(input.graph.content), nodes = records(graph?.nodes), rows = records(input.tasks)
    if (!graph || graph.schemaVersion !== 'agent-harness.v2.task-graph' || !nodes || !rows
      || input.graph.revision < receipt.graphRevision || !validSuffix(nodes, receipt, input.actor, input.packageRefs)) return false
    const byId = new Map<string, Record<string, unknown>>()
    for (const row of rows) byId.set(String(row.id), row)
    if (byId.size !== rows.length || !gateAndTasksCurrent(byId, nodes, receipt, input.actor)) return false
    const [handoffs, proposals] = await Promise.all([
      tx.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, type: HANDOFF_TYPE,
        itemId: null, taskId: null, actor: 'system' }, take: 2, select: { idempotencyKey: true, payload: true } }),
      tx.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
        idempotencyKey: `${graphId(owner.rootTaskId)}:proposal:${receipt.gateGraphRevision}` }, take: 2,
        select: { itemId: true, taskId: true, type: true, actor: true, idempotencyKey: true, payload: true } }),
    ])
    return handoffs.length === 1 && handoffs[0]?.idempotencyKey === scheduledPostGateHandoffKey(receipt)
      && sameJson(handoffs[0]?.payload, receipt) && proposals.length === 1
      && proposalMatches(proposals[0], receipt, nodes) && await gateCompletionEventIsCurrent(tx, owner, input.graph.content, nodes, receipt)
  } catch { return false }
}

export function parseScheduledPostGateHandoff(value: unknown): ScheduledPostGateHandoff | null {
  const row = record(value), owner = parseScheduledTaskGraphPipelineOwner(row?.owner), refs = strings(row?.packageRefs, 50)
  const execute = dense(row?.executeNodes)?.map(record)
  if (!row || !owner || !refs || !execute || !exact(row, ['schemaVersion', 'owner', 'snapshotDigest', 'continuationKey',
    'gateTaskId', 'gateAttemptCount', 'gateCompletedEventRevision', 'gateProofDigest', 'gateProof', 'gateResultDigest', 'packageRefs',
    'packageDigest', 'proposalDigest', 'gateGraphRevision', 'graphRevision', 'executeNodes', 'auditTaskId'])
    || row.schemaVersion !== HANDOFF_SCHEMA || !digest(row.snapshotDigest) || !validId(row.continuationKey)
    || !validId(row.gateTaskId) || !positive(row.gateAttemptCount) || !positive(row.gateCompletedEventRevision)
    || !digest(row.gateProofDigest) || !record(row.gateProof) || !digest(row.gateResultDigest) || !digest(row.packageDigest)
    || !digest(row.proposalDigest) || !positive(row.gateGraphRevision) || row.gateCompletedEventRevision !== row.gateGraphRevision
    || !positive(row.graphRevision) || row.graphRevision !== row.gateGraphRevision + 1 || !validId(row.auditTaskId)
    || hash(row.gateProof) !== row.gateProofDigest || hash(refs) !== row.packageDigest || execute.length < 1 || execute.length > 3) return null
  const parsedExecuteNodes = execute.map(node => {
    const nodeRefs = strings(node?.packageRefs, 50)
    return node && exact(node, ['key', 'taskId', 'packageRefs']) && validId(node.key) && validId(node.taskId) && nodeRefs
      ? { key: node.key, taskId: node.taskId, packageRefs: nodeRefs } : null
  })
  const executeNodes = parsedExecuteNodes.filter((node): node is NonNullable<(typeof parsedExecuteNodes)[number]> => node !== null)
  if (executeNodes.length !== parsedExecuteNodes.length || new Set(executeNodes.map(node => node.taskId)).size !== executeNodes.length
    || new Set(executeNodes.map(node => node.key)).size !== executeNodes.length
    || !sameSet(executeNodes.flatMap(node => node.packageRefs), refs)
    || executeNodes.flatMap(node => node.packageRefs).length !== refs.length) return null
  return { ...row, owner, gateTaskId: row.gateTaskId, gateAttemptCount: row.gateAttemptCount,
    gateCompletedEventRevision: row.gateCompletedEventRevision, gateGraphRevision: row.gateGraphRevision,
    graphRevision: row.graphRevision, packageRefs: refs, executeNodes, auditTaskId: row.auditTaskId }
}

export function parseScheduledPostGateExecuteEnvelope(value: unknown): { queued: string[]; failed: string[] } | null {
  const row = record(value), result = exactRecord(row?.structuredResult, ['queued', 'failed'])
  const queued = result && strings(result.queued, 50), failed = result && strings(result.failed, 50)
  return row && exact(row, ['finalItemId', 'finalText', 'status', 'stepCount', 'toolCallCount', 'taskGraphVerificationReport', 'structuredResult'])
    && result && queued && failed && row.status === 'completed' && row.finalItemId === null && row.finalText === ''
    && row.stepCount === 0 && row.toolCallCount === 0 && row.taskGraphVerificationReport === null
    && !queued.some(id => failed.includes(id)) ? { queued, failed } : null
}

function validSuffix(nodes: Record<string, unknown>[], receipt: ScheduledPostGateHandoff, actor: ScheduledTaskGraphPostGateActor,
  packageRefs?: readonly string[]): boolean {
  const gateIndex = nodes.findIndex(node => node.key === 'gate' && node.taskId === receipt.gateTaskId)
  if (gateIndex < 0 || nodes.filter(node => node.key === 'gate' || node.templateId === 'gate').length !== 1
    || nodes.length !== gateIndex + receipt.executeNodes.length + 2) return false
  const execute = receipt.executeNodes.map((reference, index) => {
    const node = nodes[gateIndex + index + 1], nodeRefs = node && strings(node.packageRefs, 50)
    return node && nodeRefs && exact(node, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition', 'packageRefs'])
      && node.key === reference.key && node.taskId === reference.taskId && node.templateId === EXECUTE_TEMPLATE && node.depth === 5
      && node.verificationDisposition === 'specialized' && node.goal === EXECUTE_GOAL && sameJson(node.successCriteria, EXECUTE_CRITERIA)
      && sameStrings(node.dependsOn, ['gate']) && sameStrings(nodeRefs, reference.packageRefs) ? node : null
  })
  const audit = nodes.at(-1), executeKeys = receipt.executeNodes.map(node => node.key)
  const mapped = receipt.executeNodes.find(node => node.taskId === actor.taskId)
  return execute.every(Boolean) && (actor.kind === 'execute' ? Boolean(mapped && packageRefs !== undefined
    && sameStrings(mapped.packageRefs, packageRefs)) : actor.taskId === receipt.auditTaskId)
    && audit !== undefined && exact(audit, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    && audit.key === AUDIT_TEMPLATE && audit.taskId === receipt.auditTaskId && audit.templateId === AUDIT_TEMPLATE && audit.depth === 6
    && audit.verificationDisposition === 'specialized' && audit.goal === AUDIT_GOAL && sameJson(audit.successCriteria, AUDIT_CRITERIA)
    && sameStrings(audit.dependsOn, executeKeys)
}

function gateAndTasksCurrent(tasks: Map<string, Record<string, unknown>>, nodes: Record<string, unknown>[], receipt: ScheduledPostGateHandoff,
  actor: ScheduledTaskGraphPostGateActor): boolean {
  const root = tasks.get(receipt.owner.rootTaskId), gate = tasks.get(receipt.gateTaskId), audit = tasks.get(receipt.auditTaskId)
  const gateNode = nodes.find(node => node.taskId === receipt.gateTaskId), gateResult = record(gate?.result), prepared = record(receipt.gateProof)?.prepareProof
  const preparedJobs = dense(record(prepared)?.result && record(record(prepared)?.result)?.jobs)?.map(record)?.filter(row => row?.status === 'prepared').map(row => String(row?.jobId)) ?? []
  const parsedGate = parseScheduledTaskGraphGateResult(gateResult?.structuredResult, preparedJobs)
  if (!root || root.status !== 'running' && root.status !== 'waiting' || root.attemptCount !== receipt.owner.rootAttemptCount
    || !gate || !gateNode || gate.status !== 'completed' || gate.attemptCount !== receipt.gateAttemptCount || gate.failureReason !== null
    || gate.taskType !== 'scheduled_taskgraph_gate' || gate.role !== 'prepare'
    || !sameJson(gate.expectedOutputSchema, { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', taskType: 'scheduled_taskgraph_gate' })
    || !sameJson(gate.allowedActions, []) || !parsedGate || parsedGate.status !== 'completed'
    || !sameStrings(parsedGate.approvedJobIds, receipt.packageRefs) || hash(gate.result) !== receipt.gateResultDigest
    || record(record(receipt.gateProof)?.gate)?.resultDigest !== receipt.gateResultDigest
    || !audit || audit.taskType !== 'scheduled_taskgraph_post_gate_audit' || audit.role !== 'auditor'
    || !sameJson(audit.expectedOutputSchema, AUDIT_SCHEMA) || !sameJson(audit.allowedActions, [])
    || audit.sessionId !== receipt.owner.sessionId || audit.turnId !== receipt.owner.turnId || audit.rootTaskId !== receipt.owner.rootTaskId
    || audit.parentTaskId !== receipt.owner.rootTaskId || audit.depth !== 1
    || audit.status !== (actor.kind === 'audit' ? 'running' : 'waiting') || audit.failureReason !== null) return false
  return receipt.executeNodes.every(reference => {
    const task = tasks.get(reference.taskId), node = nodes.find(value => value.taskId === reference.taskId)
    if (!task || !node || task.sessionId !== receipt.owner.sessionId || task.turnId !== receipt.owner.turnId
      || task.rootTaskId !== receipt.owner.rootTaskId || task.parentTaskId !== receipt.owner.rootTaskId || task.depth !== 1 || task.role !== 'executor'
      || task.taskType !== 'scheduled_taskgraph_execute' || !sameJson(task.expectedOutputSchema, EXECUTE_SCHEMA)
      || !sameJson(task.allowedActions, []) || !sameJson(task.context, {}) || task.failureReason !== null
      || !['queued', 'running', 'completed'].includes(String(task.status))) return false
    if (reference.taskId === actor.taskId) return actor.kind === 'execute' && task.status === 'running'
      && task.attemptCount === actor.attemptCount
    if (actor.kind === 'audit') {
      const output = parseScheduledPostGateExecuteEnvelope(task.result)
      return task.status === 'completed' && output !== null && output.queued.length === 0 && output.failed.length === 0
    }
    if (task.status === 'completed') {
      const output = parseScheduledPostGateExecuteEnvelope(task.result)
      return output !== null && output.queued.length === 0 && output.failed.length === 0
    }
    return true
  }) && (actor.kind !== 'audit' || actor.taskId === receipt.auditTaskId && audit.attemptCount === actor.attemptCount)
}

function proposalMatches(value: unknown, receipt: ScheduledPostGateHandoff, nodes: Record<string, unknown>[]): boolean {
  const row = record(value), payload = record(row?.payload), eventReceipt = record(payload?.receipt), created = dense(eventReceipt?.nodes)?.map(record)
  const proposalNodes: Record<string, unknown>[] = []
  for (const reference of receipt.executeNodes) {
    const node = nodes.find(value => value.taskId === reference.taskId)
    if (!node) return false
    proposalNodes.push({ key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
      dependsOn: node.dependsOn, packageRefs: node.packageRefs })
  }
  const audit = nodes.at(-1)
  if (!audit) return false
  proposalNodes.push({ key: audit.key, templateId: audit.templateId, goal: audit.goal, successCriteria: audit.successCriteria,
    dependsOn: audit.dependsOn })
  const proposal = { expectedRevision: receipt.gateGraphRevision, nodes: proposalNodes }
  return row?.itemId === graphId(receipt.owner.rootTaskId) && row.taskId === receipt.owner.rootTaskId && row.type === 'item.delta'
    && row.actor === 'orchestrator' && row.idempotencyKey === `${graphId(receipt.owner.rootTaskId)}:proposal:${receipt.gateGraphRevision}`
    && payload?.kind === 'proposal' && payload.revision === receipt.graphRevision && payload.fingerprint === hashHex(proposal)
    && hash(proposal) === receipt.proposalDigest && eventReceipt?.status === 'accepted' && eventReceipt.revision === receipt.graphRevision
    && created?.length === receipt.executeNodes.length + 1
    && sameJson(created.map(node => ({ key: node?.key, taskId: node?.taskId, status: node?.status })), [
      ...receipt.executeNodes.map(node => ({ key: node.key, taskId: node.taskId, status: 'queued' })),
      { key: AUDIT_TEMPLATE, taskId: receipt.auditTaskId, status: 'waiting' },
    ]) && sameStrings(eventReceipt.readyTaskIds, receipt.executeNodes.map(node => node.taskId))
}

async function gateCompletionEventIsCurrent(tx: Prisma.TransactionClient, owner: ScheduledTaskGraphPipelineOwner, content: unknown,
  nodes: Record<string, unknown>[], receipt: ScheduledPostGateHandoff): Promise<boolean> {
  const key = lifecycleKey(owner.rootTaskId, 'gate', receipt.gateAttemptCount), rows = await tx.agentEvent.findMany({
    where: { sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId(owner.rootTaskId), taskId: receipt.gateTaskId,
      type: 'item.delta', idempotencyKey: key }, take: 2, select: { itemId: true, taskId: true, type: true, actor: true, idempotencyKey: true, payload: true },
  })
  const row = rows[0], payload = record(row?.payload), event = record(payload?.event), item = record(payload?.item), current = record(content)
  const eventNodes = dense(record(item?.content)?.nodes)
  const gateIndex = nodes.findIndex(node => node.taskId === receipt.gateTaskId)
  return rows.length === 1 && row?.itemId === graphId(owner.rootTaskId) && row.taskId === receipt.gateTaskId
    && row.actor === 'system' && row.idempotencyKey === key && payload?.kind === 'lifecycle'
    && payload.revision === receipt.gateCompletedEventRevision && event?.type === 'task.completed' && event.nodeKey === 'gate'
    && event.expectedRevision === receipt.gateCompletedEventRevision - 1 && event.idempotencyKey === key
    && item?.id === graphId(owner.rootTaskId) && item.taskId === owner.rootTaskId && item.revision === receipt.gateCompletedEventRevision
    && gateIndex >= 0 && eventNodes !== null && sameJson({ ...record(item?.content), nodes: eventNodes },
      { ...current, nodes: nodes.slice(0, gateIndex + 1) })
}

export function scheduledPostGateHandoffKey(receipt: ScheduledPostGateHandoff): string {
  return `scheduled-post-gate-handoff:${hashHex([receipt.owner.userId, receipt.owner.sessionId, receipt.owner.turnId,
    receipt.owner.rootTaskId, receipt.owner.rootAttemptCount, receipt.gateTaskId, receipt.gateAttemptCount])}`
}
function lifecycleKey(root: string, node: string, attempt: number): string {
  return `${graphId(root)}:node:${createHash('sha256').update(node).digest('hex').slice(0, 20)}:${attempt}:task.completed`
}
function graphId(root: string): string { return `task-graph-${createHash('sha256').update(root).digest('hex')}` }
function hash(value: unknown): string { return `sha256:${hashHex(value)}` }
function hashHex(value: unknown): string { return createHash('sha256').update(stable(value), 'utf8').digest('hex') }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const row = record(value)
  return row ? `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}` : JSON.stringify(value) ?? ''
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function dense(value: unknown): unknown[] | null { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null }
function records(value: unknown): Record<string, unknown>[] | null {
  const items = dense(value)
  if (!items) return null
  const rows: Record<string, unknown>[] = []
  for (const item of items) {
    const row = record(item)
    if (!row) return null
    rows.push(row)
  }
  return rows
}
function exact(value: unknown, keys: readonly string[]): boolean { const row = record(value), own = row && Reflect.ownKeys(row); return Boolean(row && own?.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))) }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null { return exact(value, keys) ? record(value) : null }
function strings(value: unknown, max: number): string[] | null { const items = dense(value); return items && items.length <= max && items.every(validId) && new Set(items).size === items.length ? items as string[] : null }
function sameStrings(left: unknown, right: readonly string[]): boolean { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]) }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value)) }
function sameOwner(left: ScheduledTaskGraphPipelineOwner, right: ScheduledTaskGraphPipelineOwner): boolean { return OWNER_KEYS.every(key => left[key] === right[key]) }
function sameJson(left: unknown, right: unknown): boolean { return stable(left) === stable(right) }
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
function digest(value: unknown): boolean { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
