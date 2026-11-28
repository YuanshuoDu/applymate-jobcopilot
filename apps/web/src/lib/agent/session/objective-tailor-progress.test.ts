import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from '@jobcopilot/agent-protocol'
import { OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE } from '@/lib/agent/control-plane/commands/objective-tailor-execution-budget'
import { canonicalTaskGraphItemId } from './final-task-graph-source-detail'
import { readObjectiveTailorProgress } from './objective-tailor-progress'

const identities = { userId: 'user_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', revision: 4 }
const graphItemId = canonicalTaskGraphItemId(identities.rootTaskId)
const hash = (letter: string) => `sha256:${letter.repeat(64)}`

function node(key: string, taskId: string, templateId: string, dependsOn: string[], source = false) {
  return { key, taskId, templateId, goal: `goal ${key}`, successCriteria: ['Complete the assigned work'], dependsOn,
    depth: source ? 1 : 2, verificationDisposition: source ? 'typed' : 'specialized',
    ...(source ? { verification: { schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: templateId,
      criteria: [{ id: 'count', check: { kind: templateId === 'scout' ? 'candidate_count_gte' : 'finding_count_gte', minimum: 1 } }] } } : {}) }
}

function fixture(options: { correction?: boolean; reviewerResult?: unknown; foreignChild?: boolean; writerStatus?: string;
  correctionWriterStatus?: string; correctionReviewerStatus?: string } = {}) {
  const nodes = [node('scout', 'scout_task', 'scout', [], true), node('analyst', 'analyst_task', 'analyst', ['scout'], true),
    node('writer', 'writer_task', 'cover_letter_writer', ['analyst']), node('reviewer', 'reviewer_task', 'cover_letter_reviewer', ['writer'])]
  const slot: Record<string, unknown> = { slotId: 'tailor-1', sourceAnalystNodeKey: 'analyst', writerNodeKey: 'writer', reviewerNodeKey: 'reviewer' }
  if (options.correction) {
    nodes.push(node('correction_writer', 'correction_writer_task', 'cover_letter_writer', ['reviewer']),
      node('correction_reviewer', 'correction_reviewer_task', 'cover_letter_reviewer', ['correction_writer']))
    slot.correction = { writerNodeKey: 'correction_writer', reviewerNodeKey: 'correction_reviewer' }
  }
  const content = { schemaVersion: 'agent-harness.v2.task-graph', nodes, objectiveTailor: {
    schemaVersion: 'agent-harness.v2.objective-tailor-graph.v1', sourceNodeCount: 2, slots: [slot],
  } }
  const reviewResult = options.reviewerResult ?? null
  const tasks = [
    { id: 'root_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'running', result: null },
    { id: 'scout_task', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'scout', taskType: 'job_discovery', status: 'completed', result: null },
    { id: 'analyst_task', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'analyst', taskType: 'job_analysis', status: 'retrying', result: null },
    { id: 'writer_task', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'writer', taskType: 'cover_letter_draft', status: options.correction ? 'completed' : options.writerStatus ?? 'queued', result: null },
    { id: 'reviewer_task', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'reviewer', taskType: 'cover_letter_review', status: options.correction || options.reviewerResult ? 'completed' : 'waiting', result: reviewResult },
  ]
  if (options.correction) tasks.push(
    { id: 'correction_writer_task', sessionId: options.foreignChild ? 'session_other' : 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'writer', taskType: 'cover_letter_draft', status: options.correctionWriterStatus ?? 'running', result: { private: 'MATERIAL_SECRET' } },
    { id: 'correction_reviewer_task', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', parentTaskId: 'root_1', role: 'reviewer', taskType: 'cover_letter_review', status: options.correctionReviewerStatus ?? 'waiting', result: null },
  )
  const tx = {
    agentSession: { findFirst: vi.fn().mockResolvedValue({ id: 'session_1', userId: 'user_1' }) },
    agentTurn: { findFirst: vi.fn().mockResolvedValue({ ...identities, id: 'turn_1', sessionId: 'session_1', userId: 'user_1',
      source: 'user', executionMode: 'canonical_task_graph', status: 'in_progress', input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT },
      budgetSnapshot: { limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE } }) },
    agentItem: { findFirst: vi.fn().mockResolvedValue({ id: graphItemId, sessionId: 'session_1', turnId: 'turn_1', taskId: 'root_1',
      type: 'task_graph', revision: 4, content }) },
    subAgentTask: { findMany: vi.fn().mockResolvedValue(tasks) },
  }
  const transaction = tx
  const database = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'RepeatableRead' })
    return callback(transaction)
  }) } as unknown as PrismaClient
  return { database, tx, tasks }
}

function needsRevisionResult() {
  return { status: 'completed', finalText: 'PRIVATE_REVIEW_TEXT', structuredResult: { schemaVersion: 'agent-harness.v2.subagent.result',
    role: 'reviewer', status: 'completed', artifactRef: { artifactId: 'artifact_1', version: 1, contentHash: hash('a'), sourceDigest: hash('b') },
    reviewStatus: 'needs_revision', reviewHash: hash('c') } }
}

describe('Objective Tailor progress read model', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('projects bounded source and slot statuses without task or material details', async () => {
    const { database } = fixture()
    const progress = await readObjectiveTailorProgress(database, { ...identities, graphItemId })
    expect(progress).toEqual({ schemaVersion: 'agent-harness.v2.objective-tailor-progress.v1',
      identity: { sessionId: 'session_1', turnId: 'turn_1', graphItemId, rootTaskId: 'root_1', revision: 4 },
      sources: [{ ordinal: 1, role: 'scout', status: 'completed' }, { ordinal: 2, role: 'analyst', status: 'running' }],
      slots: [{ ordinal: 1, phase: 'awaiting_draft' }] })
    const serialized = JSON.stringify(progress)
    expect(serialized).not.toMatch(/scout_task|analyst_task|writer_task|PRIVATE|artifact_1|sha256/)
  })

  it('shows revision and correction phases only from a completed needs_revision Reviewer result', async () => {
    const noCorrection = fixture({ writerStatus: 'completed', reviewerResult: needsRevisionResult() })
    const pendingRevision = await readObjectiveTailorProgress(noCorrection.database, { ...identities, graphItemId })
    expect(pendingRevision?.slots).toEqual([{ ordinal: 1, phase: 'awaiting_revision' }])

    const correction = fixture({ correction: true, reviewerResult: needsRevisionResult() })
    const inProgress = await readObjectiveTailorProgress(correction.database, { ...identities, graphItemId })
    expect(inProgress?.slots).toEqual([{ ordinal: 1, phase: 'revising' }])
    expect(JSON.stringify(inProgress)).not.toMatch(/PRIVATE_REVIEW_TEXT|MATERIAL_SECRET|artifact_1|sha256/)

    const awaitingReview = fixture({ correction: true, reviewerResult: needsRevisionResult(), correctionWriterStatus: 'completed' })
    await expect(readObjectiveTailorProgress(awaitingReview.database, { ...identities, graphItemId }))
      .resolves.toMatchObject({ slots: [{ ordinal: 1, phase: 'awaiting_rereview' }] })
    const reviewing = fixture({ correction: true, reviewerResult: needsRevisionResult(), correctionWriterStatus: 'completed', correctionReviewerStatus: 'running' })
    await expect(readObjectiveTailorProgress(reviewing.database, { ...identities, graphItemId }))
      .resolves.toMatchObject({ slots: [{ ordinal: 1, phase: 'rereviewing' }] })
  })

  it.each([
    ['foreign child', { correction: true, reviewerResult: needsRevisionResult(), foreignChild: true }],
    ['missing child', { correction: true, reviewerResult: needsRevisionResult(), missingChild: true }],
    ['wrong task role', { wrongRole: true }],
  ])('fails closed for %s rows', async (_name, options) => {
    const { database, tx, tasks } = fixture(options as { correction?: boolean; reviewerResult?: unknown; foreignChild?: boolean })
    if (_name === 'missing child') tx.subAgentTask.findMany.mockResolvedValueOnce(tasks.slice(0, -1))
    if (_name === 'wrong task role') tx.subAgentTask.findMany.mockResolvedValueOnce(tasks.map(task => task.id === 'writer_task' ? { ...task, role: 'reviewer' } : task))
    await expect(readObjectiveTailorProgress(database, { ...identities, graphItemId })).resolves.toBeNull()
  })

  it('rejects cross-owner, stale revision, malformed profile, and duplicate child rows', async () => {
    const foreign = fixture()
    foreign.tx.agentSession.findFirst.mockResolvedValueOnce({ id: 'session_1', userId: 'user_2' })
    await expect(readObjectiveTailorProgress(foreign.database, { ...identities, graphItemId })).resolves.toBeNull()
    expect(foreign.tx.agentTurn.findFirst).not.toHaveBeenCalled()

    const stale = fixture()
    stale.tx.agentItem.findFirst.mockResolvedValueOnce({ id: graphItemId, sessionId: 'session_1', turnId: 'turn_1', taskId: 'root_1', type: 'task_graph', revision: 3, content: {} })
    await expect(readObjectiveTailorProgress(stale.database, { ...identities, graphItemId })).resolves.toBeNull()

    const wrongProfile = fixture()
    wrongProfile.tx.agentTurn.findFirst.mockResolvedValueOnce({ source: 'user', executionMode: 'canonical_task_graph',
      id: 'turn_1', sessionId: 'session_1', userId: 'user_1', rootTaskId: 'root_1', status: 'in_progress',
      input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }, budgetSnapshot: { limits: { maxSteps: 32 }, objectiveTailorProfile: 'legacy' } })
    await expect(readObjectiveTailorProgress(wrongProfile.database, { ...identities, graphItemId })).resolves.toBeNull()

    const duplicate = fixture()
    duplicate.tx.subAgentTask.findMany.mockResolvedValueOnce([...duplicate.tasks, duplicate.tasks[1]!])
    await expect(readObjectiveTailorProgress(duplicate.database, { ...identities, graphItemId })).resolves.toBeNull()
  })
})
