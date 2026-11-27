import { Prisma, type PrismaClient } from '@prisma/client'
import { parseSelectedJobBatchGraph, parseTaskGraphSnapshot, parseVerifiedShortlistSelectionBinding,
  sameVerifiedShortlistSelectionBinding, SELECTED_JOB_BATCH_SLOT_IDS, type SelectedJobBatchSlotId } from '@jobcopilot/agent-protocol'

import { taskDto, type TaskQueryRow } from '@/app/api/agent/sessions/query-dto'
import { verifyVerifiedShortlistSelection } from '@/lib/agent/control-plane/commands/verified-shortlist-selection'
import { canonicalTaskGraphItemId } from './final-task-graph-source-detail'
import { parseSelectedJobBatchTurnIdentity } from './selected-job-batch-turn-identity'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACTIVE_TURNS = new Set(['queued', 'in_progress'])
const LIVE_TURNS = new Set(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])
const FAILED_TURNS = new Set(['failed', 'interrupted', 'cancelled'])
const ACTIVE_TASKS = new Set(['queued', 'running', 'retrying', 'waiting', 'waiting_for_user'])
const FAILED_TASKS = new Set(['failed', 'interrupted', 'cancelled', 'closed'])
const REVIEW_STATUSES = new Set(['passed', 'needs_revision', 'rejected', 'stale'])
const RESULT_KEYS = ['finalItemId', 'finalText', 'status', 'stepCount', 'structuredResult', 'toolCallCount']
const WRITER_KEYS = ['artifactRef', 'role', 'schemaVersion', 'status']
const REVIEWER_KEYS = ['artifactRef', 'reviewHash', 'reviewStatus', 'role', 'schemaVersion', 'status']
const ROLE_RESULT_SCHEMA = 'agent-harness.v2.subagent.result'

type Ref = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>; type BranchStatus = 'pending' | 'completed' | 'failed'
type BatchTask = TaskQueryRow & Readonly<{ context: unknown }>
type PairMembers = Readonly<{ writer: { key: string; taskId: string }; reviewer: { key: string; taskId: string } }>
type Pair = Readonly<{ slotId: SelectedJobBatchSlotId; jobId: string; company: string; role: string; initial: PairMembers; correction?: PairMembers; effective: PairMembers }>

export type SelectedJobBatchWorkbenchModel = Readonly<{
  sessionId: string; turnId: string
  source: NonNullable<ReturnType<typeof parseVerifiedShortlistSelectionBinding>>['source']
  graph: Readonly<{ itemId: string; rootTaskId: string; revision: number }> | null
  status: 'pending' | 'partial' | 'completed' | 'failed'
  jobs: readonly Readonly<{
    slotId: SelectedJobBatchSlotId; jobId: string; company: string; role: string; status: BranchStatus
    writer: Readonly<{ status: BranchStatus; artifactRef?: Ref }>; reviewer: Readonly<{ status: BranchStatus; reviewStatus?: 'passed' | 'needs_revision' | 'rejected' | 'stale' }>
  }>[]
}>

/** Reads only the owner-bound selected batch Turn and its exact current graph. */
export function readSelectedJobBatchWorkbenchModel(database: PrismaClient, input: Readonly<{ userId: string; sessionId: string; turnId: string }>): Promise<SelectedJobBatchWorkbenchModel | null> {
  if (![input.userId, input.sessionId, input.turnId].every(value => typeof value === 'string' && ID.test(value))) return Promise.resolve(null)
  return database.$transaction(tx => readInTransaction(tx, input), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

async function readInTransaction(tx: Prisma.TransactionClient, input: Readonly<{ userId: string; sessionId: string; turnId: string }>): Promise<SelectedJobBatchWorkbenchModel | null> {
  const session = await tx.agentSession.findFirst({ where: { id: input.sessionId, userId: input.userId }, select: { id: true, userId: true } })
  if (!session || session.id !== input.sessionId || session.userId !== input.userId) return null
  const turn = await tx.agentTurn.findFirst({
    where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, sessionId: true, userId: true, source: true, executionMode: true, status: true, rootTaskId: true, input: true },
  })
  const binding = parseSelectedJobBatchTurnIdentity(turn?.input)
  if (!turn || turn.id !== input.turnId || turn.sessionId !== input.sessionId || turn.userId !== input.userId
    || turn.source !== 'user' || turn.executionMode !== 'canonical_task_graph' || !binding) return null
  if (!LIVE_TURNS.has(turn.status) && turn.status !== 'completed' && !FAILED_TURNS.has(turn.status)) return null
  const verified = await verifyVerifiedShortlistSelection(tx, { id: input.sessionId, userId: input.userId }, binding.source, binding.selectedJobIds)
  if (!verified || !sameVerifiedShortlistSelectionBinding(verified, binding)) return null
  const jobs = await tx.job.findMany({ where: { userId: input.userId, id: { in: [...binding.selectedJobIds] } }, select: { id: true, company: true, role: true } })
  const jobById = new Map(jobs.map(job => [job.id, job]))
  if (jobById.size !== binding.selectedJobIds.length || binding.selectedJobIds.some(id => !jobById.has(id))) return null
  const labels = binding.selectedJobIds.map((jobId, index) => {
    const job = jobById.get(jobId)!
    return { slotId: SELECTED_JOB_BATCH_SLOT_IDS[index]!, jobId, company: safeLabel(job.company), role: safeLabel(job.role) }
  })

  if (turn.rootTaskId === null) return ACTIVE_TURNS.has(turn.status) ? pendingModel(input, binding.source, labels) : null
  if (!ID.test(turn.rootTaskId)) return null
  const root = await tx.subAgentTask.findFirst({
    where: { id: turn.rootTaskId, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: turn.rootTaskId,
      parentTaskId: null, role: 'orchestrator', taskType: 'root' },
    select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true, status: true },
  })
  if (!root || root.id !== turn.rootTaskId || root.sessionId !== input.sessionId || root.turnId !== input.turnId
    || root.rootTaskId !== turn.rootTaskId || root.parentTaskId !== null || root.role !== 'orchestrator' || root.taskType !== 'root') return null
  if (!taskStatus(root.status)) return null
  const graph = await tx.agentItem.findFirst({
    where: { id: canonicalTaskGraphItemId(turn.rootTaskId), sessionId: input.sessionId, turnId: input.turnId,
      taskId: turn.rootTaskId, type: 'task_graph' },
    select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true },
  })
  if (!graph) return LIVE_TURNS.has(turn.status) && ACTIVE_TASKS.has(root.status) ? pendingModel(input, binding.source, labels) : null
  if (graph.id !== canonicalTaskGraphItemId(turn.rootTaskId) || graph.sessionId !== input.sessionId || graph.turnId !== input.turnId
    || graph.taskId !== turn.rootTaskId || graph.type !== 'task_graph' || !Number.isSafeInteger(graph.revision) || graph.revision < 1 || hasRepairNode(graph.content)) return null
  let snapshot: ReturnType<typeof parseTaskGraphSnapshot>
  try { snapshot = parseTaskGraphSnapshot(graph.content) } catch { return null }
  if (!snapshot) return null
  const pairs = pairNodes(snapshot.nodes, labels)
  if (!pairs) return null
  const taskIds = pairs.flatMap(pair => [pair.initial.writer.taskId, pair.initial.reviewer.taskId,
    ...(pair.correction ? [pair.correction.writer.taskId, pair.correction.reviewer.taskId] : [])])
  const rows = await tx.subAgentTask.findMany({
    where: { id: { in: taskIds }, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: turn.rootTaskId },
    select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, path: true,
      role: true, taskType: true, status: true, goal: true, confidence: true, failureReason: true, result: true,
      context: true, attemptCount: true, createdAt: true, updatedAt: true },
  }) as BatchTask[]
  if (rows.length !== taskIds.length) return null
  const tasks = new Map(rows.map(row => [row.id, row]))
  if (tasks.size !== taskIds.length || rows.some(row => row.sessionId !== input.sessionId || row.turnId !== input.turnId
    || row.rootTaskId !== turn.rootTaskId || row.parentTaskId !== turn.rootTaskId)) return null
  const projected: SelectedJobBatchWorkbenchModel['jobs'][number][] = []
  for (const pair of pairs) {
    let initial: SelectedJobBatchWorkbenchModel['jobs'][number] | null = null
    if (pair.correction) {
      initial = await projectPair(tx, input, pair, tasks, pair.initial, true)
      if (!initial || initial.status !== 'completed' || initial.reviewer.reviewStatus !== 'needs_revision' || !initial.writer.artifactRef) return null
    }
    const outcome = await projectPair(tx, input, pair, tasks, pair.effective, false, pair.correction ? initial?.writer.artifactRef : undefined)
    if (!outcome) return null
    projected.push(outcome)
  }
  return { sessionId: input.sessionId, turnId: input.turnId, source: binding.source,
    graph: { itemId: graph.id, rootTaskId: turn.rootTaskId, revision: graph.revision },
    status: aggregate(projected.map(job => job.status), turn.status, root.status), jobs: projected }
}

async function projectPair(tx: Prisma.TransactionClient, owner: { userId: string; sessionId: string; turnId: string }, pair: Pair,
  tasks: Map<string, BatchTask>, members: PairMembers = pair.effective, requireCurrentSource = false, expectedPrevious?: Ref): Promise<SelectedJobBatchWorkbenchModel['jobs'][number] | null> {
  const writer = tasks.get(members.writer.taskId), reviewer = tasks.get(members.reviewer.taskId)
  if (!writer || !reviewer || writer.role !== 'writer' || writer.taskType !== 'cover_letter_draft'
    || reviewer.role !== 'reviewer' || reviewer.taskType !== 'cover_letter_review'
    || !taskContextMatches(writer.context, pair.jobId) || !taskContextMatches(reviewer.context, pair.jobId)) return null
  const writerStatus = taskStatus(writer.status), reviewerStatus = taskStatus(reviewer.status)
  if (!writerStatus || !reviewerStatus || reviewerStatus === 'completed' && writerStatus !== 'completed') return null
  const base = { slotId: pair.slotId, jobId: pair.jobId, company: pair.company, role: pair.role,
    writer: { status: writerStatus }, reviewer: { status: reviewerStatus } }
  if (writerStatus === 'failed' || reviewerStatus === 'failed') return { ...base, status: 'failed' }
  if (writerStatus !== 'completed' || reviewerStatus !== 'completed') return { ...base, status: 'pending' }
  const writerRef = taskDto(writer).artifactRef, reviewerRef = taskDto(reviewer).artifactRef
  const writerResultValid = roleResult(writer.result, 'writer'), receipt = reviewerResult(reviewer.result)
  if (!writerRef || !reviewerRef || !writerResultValid || !receipt || !sameRef(writerRef, reviewerRef)) return null
  const version = await tx.agentArtifactVersion.findFirst({
    where: { artifactId: writerRef.artifactId, version: writerRef.version, userId: owner.userId, sessionId: owner.sessionId,
      jobId: pair.jobId, artifactType: 'cover_letter', taskId: writer.id, contentHash: writerRef.contentHash, sourceDigest: writerRef.sourceDigest },
    select: { id: true, artifactId: true, version: true, userId: true, sessionId: true, jobId: true, artifactType: true,
      taskId: true, contentHash: true, sourceDigest: true, previousHash: true },
  })
  if (!version || version.artifactId !== writerRef.artifactId || version.version !== writerRef.version || version.userId !== owner.userId
    || version.sessionId !== owner.sessionId || version.jobId !== pair.jobId || version.artifactType !== 'cover_letter'
    || version.taskId !== writer.id || version.contentHash !== writerRef.contentHash || version.sourceDigest !== writerRef.sourceDigest
    || expectedPrevious && (writerRef.artifactId !== expectedPrevious.artifactId || writerRef.version !== expectedPrevious.version + 1
      || writerRef.sourceDigest !== expectedPrevious.sourceDigest || version.previousHash !== expectedPrevious.contentHash)) return null
  const review = await tx.agentArtifactReview.findFirst({
    where: { artifactVersionId: version.id, userId: owner.userId, sessionId: owner.sessionId, jobId: pair.jobId,
      taskId: reviewer.id, artifactId: writerRef.artifactId, version: writerRef.version, contentHash: writerRef.contentHash,
      sourceDigest: writerRef.sourceDigest, reviewHash: receipt.reviewHash, status: receipt.reviewStatus },
    select: { artifactVersionId: true, userId: true, sessionId: true, jobId: true, taskId: true, artifactId: true,
      version: true, contentHash: true, sourceDigest: true, currentSourceDigest: true, reviewHash: true, status: true },
  })
  if (!review || review.artifactVersionId !== version.id || review.userId !== owner.userId || review.sessionId !== owner.sessionId
    || review.jobId !== pair.jobId || review.taskId !== reviewer.id || review.artifactId !== writerRef.artifactId
    || review.version !== writerRef.version || review.contentHash !== writerRef.contentHash || review.sourceDigest !== writerRef.sourceDigest
    || review.reviewHash !== receipt.reviewHash || review.status !== receipt.reviewStatus || !isDigest(review.currentSourceDigest)
    || requireCurrentSource && review.currentSourceDigest !== writerRef.sourceDigest) return null
  return { ...base, status: 'completed', writer: { status: 'completed', artifactRef: writerRef },
    reviewer: { status: 'completed', reviewStatus: receipt.reviewStatus } }
}

function pairNodes(nodes: NonNullable<ReturnType<typeof parseTaskGraphSnapshot>>['nodes'], labels: readonly {
  slotId: SelectedJobBatchSlotId; jobId: string; company: string; role: string
}[]): Pair[] | null {
  const parsed = parseSelectedJobBatchGraph(nodes, labels.map(label => label.slotId))
  if (!parsed || parsed.length !== labels.length) return null
  return labels.map((label, index) => {
    const chain = parsed[index]!
    return { ...label, initial: chain.initial, ...(chain.correction ? { correction: chain.correction } : {}), effective: chain.effective }
  })
}

function roleResult(value: unknown, role: 'writer'): boolean {
  const envelope = exactRecord(value, RESULT_KEYS), result = record(envelope?.structuredResult)
  return Boolean(envelope && envelope.status === 'completed' && Number.isSafeInteger(envelope.stepCount)
    && Number.isSafeInteger(envelope.toolCallCount) && typeof envelope.finalText === 'string'
    && (envelope.finalItemId === null || typeof envelope.finalItemId === 'string')
    && result && hasKeys(result, WRITER_KEYS) && result.schemaVersion === ROLE_RESULT_SCHEMA
    && result.role === role && result.status === 'completed')
}

function taskContextMatches(value: unknown, jobId: string): boolean {
  const context = record(value), selected = exactRecord(context?.selectedJobPreparation, ['jobId'])
  return selected?.jobId === jobId
}

function reviewerResult(value: unknown): Readonly<{ reviewStatus: 'passed' | 'needs_revision' | 'rejected' | 'stale'; reviewHash: string }> | null {
  const envelope = exactRecord(value, RESULT_KEYS), result = record(envelope?.structuredResult)
  if (!envelope || envelope.status !== 'completed' || !Number.isSafeInteger(envelope.stepCount) || !Number.isSafeInteger(envelope.toolCallCount)
    || typeof envelope.finalText !== 'string' || !(envelope.finalItemId === null || typeof envelope.finalItemId === 'string')
    || !result || !hasKeys(result, REVIEWER_KEYS) || result.schemaVersion !== ROLE_RESULT_SCHEMA || result.role !== 'reviewer'
    || result.status !== 'completed' || typeof result.reviewStatus !== 'string' || !REVIEW_STATUSES.has(result.reviewStatus)
    || !isDigest(result.reviewHash)) return null
  return { reviewStatus: result.reviewStatus as 'passed' | 'needs_revision' | 'rejected' | 'stale', reviewHash: result.reviewHash }
}

function pendingModel(input: { sessionId: string; turnId: string }, source: NonNullable<ReturnType<typeof parseVerifiedShortlistSelectionBinding>>['source'], labels: readonly { slotId: SelectedJobBatchSlotId; jobId: string; company: string; role: string }[]): SelectedJobBatchWorkbenchModel {
  const jobs = labels.map(job => ({ ...job, status: 'pending' as const, writer: { status: 'pending' as const }, reviewer: { status: 'pending' as const } }))
  return { sessionId: input.sessionId, turnId: input.turnId, source, graph: null, status: 'pending', jobs }
}

function taskStatus(value: string): BranchStatus | null {
  if (value === 'completed') return 'completed'
  if (FAILED_TASKS.has(value)) return 'failed'
  return ACTIVE_TASKS.has(value) ? 'pending' : null
}

function aggregate(statuses: readonly BranchStatus[], turnStatus: string, rootStatus: string): 'pending' | 'partial' | 'completed' | 'failed' {
  if (FAILED_TURNS.has(turnStatus) || FAILED_TASKS.has(rootStatus)) return 'failed'
  if (statuses.every(status => status === 'completed')) return turnStatus === 'completed' && rootStatus === 'completed' ? 'completed' : 'pending'
  if (statuses.every(status => status === 'failed')) return turnStatus === 'completed' && rootStatus === 'completed' ? 'failed' : 'partial'
  return statuses.some(status => status === 'failed') ? 'partial' : 'pending'
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}

function isDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
function safeLabel(value: unknown): string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160 ? value : 'Saved job'
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function hasRepairNode(value: unknown): boolean { const nodes = record(value)?.nodes; return Array.isArray(nodes) && nodes.some(node => Object.hasOwn(record(node) ?? {}, 'repairOf')) }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null { const row = record(value); return row && hasKeys(row, keys) ? row : null }
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown } catch { return null } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const own = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== 'string')) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of own as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}
