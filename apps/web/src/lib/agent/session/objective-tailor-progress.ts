import { Prisma, type PrismaClient } from '@prisma/client'
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from '@jobcopilot/agent-protocol'

import { OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE } from '@/lib/agent/control-plane/commands/objective-tailor-execution-budget'
import { canonicalTaskGraphItemId } from './final-task-graph-source-detail'
import { parseObjectiveTailorProgress, type ObjectiveTailorProgress, type ObjectiveTailorProgressSlotPhase } from './objective-tailor-progress-contract'
import { parseObjectiveTailorProgressSnapshot, type ObjectiveTailorProgressSnapshot } from './objective-tailor-progress-snapshot'

const TASK_STATUSES = new Set(['queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed'])
const TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed'])
const RESULT_SCHEMA = 'agent-harness.v2.subagent.result'
const HASH = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export type ObjectiveTailorProgressInput = Readonly<{ userId: string; sessionId: string; turnId: string; graphItemId: string; rootTaskId: string; revision: number }>
type TaskRow = Readonly<{ id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null; role: string; taskType: string; status: string; result: unknown }>
type ProgressTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Projects only a current marked Objective graph and its exact owner-scoped child rows. */
export function readObjectiveTailorProgress(database: PrismaClient, input: ObjectiveTailorProgressInput): Promise<ObjectiveTailorProgress | null> {
  if (![input.userId, input.sessionId, input.turnId, input.graphItemId, input.rootTaskId].every(value => ID.test(value))
    || !Number.isSafeInteger(input.revision) || input.revision < 1) return Promise.resolve(null)
  return database.$transaction(tx => readCurrent(tx, input), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

async function readCurrent(tx: Prisma.TransactionClient, input: ObjectiveTailorProgressInput): Promise<ObjectiveTailorProgress | null> {
  const session = await tx.agentSession.findFirst({ where: { id: input.sessionId, userId: input.userId }, select: { id: true, userId: true } })
  if (!session || session.id !== input.sessionId || session.userId !== input.userId) return null
  const turn = await tx.agentTurn.findFirst({ where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, sessionId: true, userId: true, source: true, executionMode: true, status: true, rootTaskId: true, input: true, budgetSnapshot: true } })
  if (!turn || turn.id !== input.turnId || turn.sessionId !== input.sessionId || turn.userId !== input.userId
    || turn.source !== 'user' || turn.executionMode !== 'canonical_task_graph' || turn.rootTaskId !== input.rootTaskId
    || !TURN_STATUSES.has(turn.status) || !objectiveInput(turn.input) || !objectiveBudget(turn.budgetSnapshot)) return null
  if (input.graphItemId !== canonicalTaskGraphItemId(input.rootTaskId)) return null
  const graph = await tx.agentItem.findFirst({ where: { id: input.graphItemId, sessionId: input.sessionId, turnId: input.turnId,
    taskId: input.rootTaskId, type: 'task_graph', revision: input.revision },
  select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true } })
  if (!graph || graph.id !== input.graphItemId || graph.sessionId !== input.sessionId || graph.turnId !== input.turnId
    || graph.taskId !== input.rootTaskId || graph.type !== 'task_graph' || graph.revision !== input.revision) return null
  const snapshot = parseObjectiveTailorProgressSnapshot(graph.content)
  if (!snapshot) return null
  const ids = [input.rootTaskId, ...snapshot.nodes.map(node => node.taskId)]
  if (new Set(ids).size !== ids.length || ids.some(id => !ID.test(id))) return null
  const rows = await tx.subAgentTask.findMany({ where: { id: { in: ids }, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: input.rootTaskId },
    take: ids.length, select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true, status: true, result: true } }) as TaskRow[]
  const tasks = validateTaskRows(rows, ids, snapshot, input)
  if (!tasks) return null
  const sources = snapshot.nodes.slice(0, snapshot.marker.sourceNodeCount).map((node, index) => ({
    ordinal: index + 1, role: node.templateId as 'scout' | 'analyst', status: tasks.get(node.key)!.progressStatus,
  }))
  const slots = snapshot.marker.slots.map((slot, index) => ({ ordinal: index + 1, phase: slotPhase(slot, tasks) }))
  if (slots.some(slot => !slot.phase)) return null
  return parseObjectiveTailorProgress({ schemaVersion: 'agent-harness.v2.objective-tailor-progress.v1',
    identity: { sessionId: input.sessionId, turnId: input.turnId, graphItemId: input.graphItemId, rootTaskId: input.rootTaskId, revision: input.revision },
    sources, slots }) ?? null
}

function validateTaskRows(rows: readonly TaskRow[], ids: readonly string[], snapshot: ObjectiveTailorProgressSnapshot, input: ObjectiveTailorProgressInput) {
  if (rows.length !== ids.length) return null
  const byId = new Map<string, TaskRow>()
  for (const row of rows) {
    if (!row || byId.has(row.id) || row.sessionId !== input.sessionId || row.turnId !== input.turnId || row.rootTaskId !== input.rootTaskId
      || !TASK_STATUSES.has(row.status) || !ID.test(row.id) || !ID.test(row.taskType)) return null
    byId.set(row.id, row)
  }
  if (ids.some(id => !byId.has(id))) return null
  const root = byId.get(input.rootTaskId)!
  if (root.parentTaskId !== null || root.role !== 'orchestrator' || root.taskType !== 'root') return null
  const tasks = new Map<string, TaskRow & { progressStatus: ProgressTaskStatus }>()
  for (const node of snapshot.nodes) {
    const task = byId.get(node.taskId)!, expected = taskRole(node.templateId)
    if (task.parentTaskId !== input.rootTaskId || !expected || task.role !== expected.role
      || expected.taskType !== null && task.taskType !== expected.taskType || !status(task.status)) return null
    tasks.set(node.key, Object.assign({ ...task }, { progressStatus: status(task.status)! }))
  }
  return tasks
}

function slotPhase(slot: ObjectiveTailorProgressSnapshot['marker']['slots'][number],
  tasks: Map<string, TaskRow & { progressStatus: ProgressTaskStatus }>): ObjectiveTailorProgressSlotPhase | undefined {
  const writer = tasks.get(slot.writerNodeKey), reviewer = tasks.get(slot.reviewerNodeKey)
  if (!writer || !reviewer) return undefined
  if (slot.correction) {
    if (writer.progressStatus !== 'completed' || reviewer.progressStatus !== 'completed' || !needsRevision(reviewer.result)) return undefined
    const correctionWriter = tasks.get(slot.correction.writerNodeKey), correctionReviewer = tasks.get(slot.correction.reviewerNodeKey)
    if (!correctionWriter || !correctionReviewer) return undefined
    return correctionPhase(correctionWriter.progressStatus, correctionReviewer.progressStatus)
  }
  if (reviewer.progressStatus === 'completed' && writer.progressStatus !== 'completed') return undefined
  return pairPhase(writer.progressStatus, reviewer.progressStatus, reviewer.progressStatus === 'completed' && needsRevision(reviewer.result))
}

function correctionPhase(writer: ProgressTaskStatus, reviewer: ProgressTaskStatus): ObjectiveTailorProgressSlotPhase {
  if (writer === 'failed' || reviewer === 'failed') return 'failed'
  if (writer === 'pending') return 'awaiting_revision'
  if (writer === 'running') return 'revising'
  if (reviewer === 'pending') return 'awaiting_rereview'
  if (reviewer === 'running') return 'rereviewing'
  return 'completed'
}

function pairPhase(writer: ProgressTaskStatus, reviewer: ProgressTaskStatus, needsRevisionResult: boolean): ObjectiveTailorProgressSlotPhase {
  if (writer === 'failed' || reviewer === 'failed') return 'failed'
  if (writer === 'pending') return 'awaiting_draft'
  if (writer === 'running') return 'drafting'
  if (reviewer === 'pending') return 'awaiting_review'
  if (reviewer === 'running') return 'reviewing'
  return needsRevisionResult ? 'awaiting_revision' : 'completed'
}

function status(value: string): ProgressTaskStatus | undefined {
  if (value === 'queued' || value === 'waiting' || value === 'waiting_for_user') return 'pending'
  if (value === 'running' || value === 'retrying') return 'running'
  if (value === 'completed') return 'completed'
  if (value === 'failed' || value === 'interrupted' || value === 'cancelled' || value === 'closed') return 'failed'
  return undefined
}

function taskRole(templateId: string): Readonly<{ role: string; taskType: string | null }> | undefined {
  if (templateId === 'scout') return { role: 'scout', taskType: null }
  if (templateId === 'analyst') return { role: 'analyst', taskType: 'job_analysis' }
  if (templateId === 'cover_letter_writer') return { role: 'writer', taskType: 'cover_letter_draft' }
  if (templateId === 'cover_letter_reviewer') return { role: 'reviewer', taskType: 'cover_letter_review' }
  return undefined
}

function needsRevision(value: unknown): boolean {
  const envelope = record(value), result = record(envelope?.structuredResult), ref = record(result?.artifactRef)
  if (!envelope || envelope.status !== 'completed' || result?.schemaVersion !== RESULT_SCHEMA || result.role !== 'reviewer'
    || result.status !== 'completed' || result.reviewStatus !== 'needs_revision' || !exact(result, ['artifactRef', 'reviewHash', 'reviewStatus', 'role', 'schemaVersion', 'status'])
    || typeof result.reviewHash !== 'string' || !HASH.test(result.reviewHash)
    || !exact(ref, ['artifactId', 'contentHash', 'sourceDigest', 'version']) || !ref || typeof ref.artifactId !== 'string' || !ID.test(ref.artifactId)
    || typeof ref.contentHash !== 'string' || !HASH.test(ref.contentHash) || typeof ref.sourceDigest !== 'string' || !HASH.test(ref.sourceDigest)
    || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1) return false
  return true
}

function objectiveInput(value: unknown): boolean {
  const input = record(value), intent = record(input?.intent)
  return !!input && !!intent && exact(intent, ['kind', 'version']) && intent.kind === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind
    && intent.version === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
    && !['selectedJobPreparation', 'selectedJobBatchPreparation', 'verifiedShortlistSelection'].some(key => Object.hasOwn(input, key))
}

function objectiveBudget(value: unknown): boolean {
  const budget = record(value), limits = record(budget?.limits)
  return !!budget && exact(budget, ['limits', 'objectiveTailorProfile']) && !!limits && exact(limits, ['maxSteps'])
    && limits.maxSteps === 96 && budget.objectiveTailorProfile === OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE
}

function exact(value: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (!value) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown } catch { return undefined } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== 'string')) return undefined
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}
