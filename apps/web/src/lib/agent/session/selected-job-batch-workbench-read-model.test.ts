import { Prisma, type PrismaClient } from '@prisma/client'
import { TASK_GRAPH_SCHEMA_VERSION, VERIFIED_SHORTLIST_SELECTION_SCHEMA } from '@jobcopilot/agent-protocol'
import { describe, expect, it, vi } from 'vitest'

import { canonicalTaskGraphItemId } from './final-task-graph-source-detail'
import { readSelectedJobBatchWorkbenchModel } from './selected-job-batch-workbench-read-model'

const owner = { userId: 'user_1', sessionId: 'session_1', turnId: 'batch_turn_1' }
const source = { sessionId: owner.sessionId, sourceTurnId: 'source_turn_1', rootTaskId: 'source_root_1',
  graphItemId: canonicalTaskGraphItemId('source_root_1'), graphRevision: 3 }
const selectedJobIds = ['job_1', 'job_2']
const binding = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds }
const batchGoal = 'Prepare draft materials for the selected Jobs from the verified shortlist. Do not submit applications.'
const batchInput = { clientMessageId: 'batch_1', content: [{ type: 'text', text: batchGoal }], goal: batchGoal,
  intent: { kind: 'selected_job_batch_preparation', version: 1 }, verifiedShortlistSelection: binding }
const sourceTurn = { id: source.sourceTurnId, sessionId: owner.sessionId, userId: owner.userId, source: 'user', status: 'completed',
  rootTaskId: source.rootTaskId, executionMode: null, input: { intent: { kind: 'interactive_discovery_shortlist', version: 1 } } }
const shortlist = { schemaVersion: 1, status: 'completed', items: selectedJobIds.map((jobId, index) => ({
  jobId, score: 9 - index, evidenceIds: [`read:job:${jobId}`],
})), failures: [] }
const sourceRoot = { id: source.rootTaskId, sessionId: owner.sessionId, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
  parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'completed', failureReason: null,
  result: { status: 'completed', structuredResult: { interactiveDiscoveryShortlist: shortlist } } }
const sourceGraph = { id: source.graphItemId, sessionId: owner.sessionId, turnId: source.sourceTurnId, taskId: source.rootTaskId,
  type: 'task_graph', revision: source.graphRevision, content: { schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [
    { key: 'scout', templateId: 'scout', goal: 'Find jobs', successCriteria: ['Save evidence'], dependsOn: [], depth: 1, taskId: 'scout_1' },
    { key: 'analyst', templateId: 'analyst', goal: 'Score jobs', successCriteria: ['Compare jobs'], dependsOn: ['scout'], depth: 2, taskId: 'analyst_1' },
  ] } }
const root = { id: 'batch_root_1', sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: 'batch_root_1', parentTaskId: null,
  role: 'orchestrator', taskType: 'root', status: 'running' }
const currentNodes = [
  { key: 'writer_1', templateId: 'cover_letter_writer_slot_1', goal: 'private writer goal', successCriteria: ['draft'],
    dependsOn: [], depth: 1, taskId: 'writer_task_1', verificationDisposition: 'specialized' },
  { key: 'reviewer_1', templateId: 'cover_letter_reviewer_slot_1', goal: 'private reviewer goal', successCriteria: ['review'],
    dependsOn: ['writer_1'], depth: 2, taskId: 'reviewer_task_1', verificationDisposition: 'specialized' },
  { key: 'writer_2', templateId: 'cover_letter_writer_slot_2', goal: 'private writer goal', successCriteria: ['draft'],
    dependsOn: [], depth: 1, taskId: 'writer_task_2', verificationDisposition: 'specialized' },
  { key: 'reviewer_2', templateId: 'cover_letter_reviewer_slot_2', goal: 'private reviewer goal', successCriteria: ['review'],
    dependsOn: ['writer_2'], depth: 2, taskId: 'reviewer_task_2', verificationDisposition: 'specialized' },
]
const currentGraph = { id: canonicalTaskGraphItemId('batch_root_1'), sessionId: owner.sessionId, turnId: owner.turnId,
  taskId: 'batch_root_1', type: 'task_graph', revision: 5, content: { schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: currentNodes } }
const refs = selectedJobIds.map((jobId, index) => ({ artifactId: `artifact_${index + 1}`, version: 2,
  contentHash: `sha256:${String(index + 1).repeat(64)}`, sourceDigest: `sha256:${String(index + 3).repeat(64)}` }))
const taskRows = selectedJobIds.flatMap((jobId, index) => {
  const makeResult = (role: 'writer' | 'reviewer') => ({ status: 'completed', stepCount: 2, toolCallCount: 1,
    finalItemId: null, finalText: 'PRIVATE_MODEL_TEXT', structuredResult: {
      schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', artifactRef: refs[index],
      ...(role === 'reviewer' ? { reviewStatus: 'passed', reviewHash: `sha256:${String(index + 5).repeat(64)}` } : {}),
    } })
  return [
    { id: `writer_task_${index + 1}`, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: root.id, parentTaskId: root.id,
      path: `/writer-${index + 1}`, role: 'writer', taskType: 'cover_letter_draft', status: 'completed', goal: 'private goal',
      confidence: null, failureReason: null, result: makeResult('writer'), context: { selectedJobPreparation: { jobId } },
      attemptCount: 1, createdAt: new Date(0), updatedAt: new Date(0) },
    { id: `reviewer_task_${index + 1}`, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: root.id, parentTaskId: root.id,
      path: `/reviewer-${index + 1}`, role: 'reviewer', taskType: 'cover_letter_review', status: 'completed', goal: 'private goal',
      confidence: null, failureReason: null, result: makeResult('reviewer'), context: { selectedJobPreparation: { jobId } },
      attemptCount: 1, createdAt: new Date(0), updatedAt: new Date(0) },
  ]
})

function fixture(options: { queued?: boolean; rows?: typeof taskRows; graph?: typeof currentGraph | null; contextJob?: string; ownerMatch?: boolean; turnStatus?: string; rootStatus?: string; storedInput?: unknown; turnSource?: string; executionMode?: string } = {}) {
  const rows = (options.rows ?? taskRows).map(row => ({ ...row }))
  const selectedTurn = { id: owner.turnId, sessionId: owner.sessionId, userId: owner.userId, source: options.turnSource ?? 'user',
    executionMode: options.executionMode ?? 'canonical_task_graph', status: options.turnStatus ?? (options.queued ? 'queued' : 'in_progress'),
    rootTaskId: options.queued ? null : root.id, input: options.storedInput ?? batchInput }
  const selectedRoot = { ...root, status: options.rootStatus ?? root.status }
  const tx = {
    agentSession: { findFirst: vi.fn().mockResolvedValue(options.ownerMatch === false ? null : { id: owner.sessionId, userId: owner.userId }) },
    agentTurn: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sourceTurn.id ? sourceTurn : where.id === owner.turnId ? selectedTurn : null) },
    subAgentTask: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => where.id === sourceRoot.id ? sourceRoot : where.id === root.id ? selectedRoot : null),
      findMany: vi.fn().mockResolvedValue(rows),
    },
    agentItem: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sourceGraph.id ? sourceGraph : where.id === currentGraph.id ? (options.graph === undefined ? currentGraph : options.graph) : null) },
    job: { findMany: vi.fn().mockImplementation(async ({ where, select }: { where: { id: { in: string[] } }; select: Record<string, boolean> }) =>
      where.id.in.map((id, index) => select.company ? { id, company: `Company ${index + 1}`, role: `Role ${index + 1}` } : { id })) },
    agentArtifactVersion: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: { artifactId: string; version: number } }) => {
      const index = refs.findIndex(ref => ref.artifactId === where.artifactId && ref.version === where.version)
      return index < 0 ? null : { id: `version_${index + 1}`, ...where, userId: owner.userId, sessionId: owner.sessionId,
        jobId: selectedJobIds[index], artifactType: 'cover_letter', taskId: `writer_task_${index + 1}`,
        contentHash: refs[index]?.contentHash, sourceDigest: refs[index]?.sourceDigest }
    }) },
    agentArtifactReview: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: { artifactVersionId: string; taskId: string } }) => {
      const index = Number(where.artifactVersionId.slice(-1)) - 1
      return { ...where, userId: owner.userId, sessionId: owner.sessionId, jobId: selectedJobIds[index],
        taskId: `reviewer_task_${index + 1}`, artifactId: refs[index]?.artifactId, version: refs[index]?.version,
        contentHash: refs[index]?.contentHash, sourceDigest: refs[index]?.sourceDigest, currentSourceDigest: refs[index]?.sourceDigest,
        reviewHash: `sha256:${String(index + 5).repeat(64)}`, status: 'passed' }
    }) },
  }
  if (options.contextJob) {
    const row = rows.find(task => task.id === 'writer_task_2')!
    row.context = { selectedJobPreparation: { jobId: options.contextJob } }
  }
  const database = { $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>, config: unknown) => {
    expect(config).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    return work(tx)
  }) } as unknown as PrismaClient
  return { database, tx }
}

describe('selected Job batch Workbench read model', () => {
  it('returns pending for an owner-verified queued Turn before Root or graph creation', async () => {
    const test = fixture({ queued: true })
    const result = await readSelectedJobBatchWorkbenchModel(test.database, owner)

    expect(result).toMatchObject({ status: 'pending', graph: null, jobs: [
      { slotId: 'slot-1', jobId: 'job_1', company: 'Company 1', status: 'pending', writer: { status: 'pending' }, reviewer: { status: 'pending' } },
      { slotId: 'slot-2', jobId: 'job_2', company: 'Company 2', status: 'pending' },
    ] })
    expect(result?.jobs[0]).not.toHaveProperty('writer.artifactRef')
    expect(result?.jobs[0]).not.toHaveProperty('reviewer.reviewStatus')
    expect(test.tx.subAgentTask.findMany).not.toHaveBeenCalled()
  })

  it('uses the closed shared Turn parser and canonical owner fields before reading source evidence', async () => {
    const invalid = [
      fixture({ storedInput: { ...batchInput, extra: true } }),
      fixture({ storedInput: { ...batchInput, intent: { ...batchInput.intent, extra: true } } }),
      fixture({ turnSource: 'automation' }),
      fixture({ executionMode: 'legacy' }),
    ]
    for (const test of invalid) {
      expect(await readSelectedJobBatchWorkbenchModel(test.database, owner)).toBeNull()
      expect(test.tx.agentTurn.findFirst).toHaveBeenCalledTimes(1)
      expect(test.tx.job.findMany).not.toHaveBeenCalled()
    }
  })

  it('projects two completed same-slot artifact and Reviewer receipts without private task output', async () => {
    const test = fixture({ turnStatus: 'completed', rootStatus: 'completed' })
    const result = await readSelectedJobBatchWorkbenchModel(test.database, owner)

    expect(result).toMatchObject({ status: 'completed', graph: { itemId: currentGraph.id, revision: 5 }, jobs: [
      { slotId: 'slot-1', jobId: 'job_1', status: 'completed', writer: { artifactRef: refs[0] }, reviewer: { reviewStatus: 'passed' } },
      { slotId: 'slot-2', jobId: 'job_2', status: 'completed', writer: { artifactRef: refs[1] }, reviewer: { reviewStatus: 'passed' } },
    ] })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('PRIVATE_MODEL_TEXT')
    expect(serialized).not.toContain('private goal')
    expect(serialized).not.toContain('reviewHash')
    expect(test.tx.agentArtifactVersion.findFirst).toHaveBeenCalledTimes(2)
    expect(test.tx.agentArtifactReview.findFirst).toHaveBeenCalledTimes(2)
  })

  it('uses the durable Turn and Root lifecycle before reporting batch completion', async () => {
    const active = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus: 'in_progress', rootStatus: 'running' }).database, owner)
    expect(active).toMatchObject({ status: 'pending', jobs: [
      { status: 'completed', writer: { artifactRef: refs[0] }, reviewer: { reviewStatus: 'passed' } },
      { status: 'completed', writer: { artifactRef: refs[1] }, reviewer: { reviewStatus: 'passed' } },
    ] })

    const turnFailed = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus: 'failed', rootStatus: 'completed' }).database, owner)
    const rootFailed = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus: 'in_progress', rootStatus: 'failed' }).database, owner)
    expect(turnFailed?.status).toBe('failed')
    expect(rootFailed?.status).toBe('failed')
    expect(turnFailed?.jobs).toEqual(active?.jobs)
    expect(rootFailed?.jobs).toEqual(active?.jobs)

    const completed = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus: 'completed', rootStatus: 'completed' }).database, owner)
    expect(completed?.status).toBe('completed')
    expect(completed?.jobs).toEqual(active?.jobs)
  })

  it('keeps mixed terminal snapshots non-complete and allows a missing graph only while both owners are active', async () => {
    const evidence = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus: 'in_progress', rootStatus: 'running' }).database, owner)
    for (const [turnStatus, rootStatus] of [['in_progress', 'completed'], ['completed', 'running']] as const) {
      const mixed = await readSelectedJobBatchWorkbenchModel(fixture({ turnStatus, rootStatus }).database, owner)
      expect(mixed?.status).not.toBe('completed')
      expect(mixed?.jobs).toEqual(evidence?.jobs)
    }

    const beforeGraph = await readSelectedJobBatchWorkbenchModel(fixture({ graph: null, turnStatus: 'in_progress', rootStatus: 'running' }).database, owner)
    expect(beforeGraph).toMatchObject({ status: 'pending', graph: null })
    expect(await readSelectedJobBatchWorkbenchModel(fixture({ graph: null, turnStatus: 'completed', rootStatus: 'completed' }).database, owner)).toBeNull()
  })

  it('denies cross-slot task context, cross-linked graph, stale source, and foreign owner reads', async () => {
    const crossContext = fixture({ contextJob: 'job_1' })
    expect(await readSelectedJobBatchWorkbenchModel(crossContext.database, owner)).toBeNull()

    const crossed = { ...currentGraph, content: { ...currentGraph.content, nodes: currentNodes.map(node =>
      node.key === 'reviewer_2' ? { ...node, dependsOn: ['writer_1'] } : node) } }
    expect(await readSelectedJobBatchWorkbenchModel(fixture({ graph: crossed }).database, owner)).toBeNull()

    const stale = fixture()
    stale.tx.agentItem.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sourceGraph.id ? { ...sourceGraph, revision: source.graphRevision + 1 } : currentGraph)
    expect(await readSelectedJobBatchWorkbenchModel(stale.database, owner)).toBeNull()
    expect(await readSelectedJobBatchWorkbenchModel(fixture({ ownerMatch: false }).database, owner)).toBeNull()
  })

  it('fails closed when a completed pair lacks its exact persisted review receipt', async () => {
    const test = fixture()
    test.tx.agentArtifactReview.findFirst.mockResolvedValue(null)
    expect(await readSelectedJobBatchWorkbenchModel(test.database, owner)).toBeNull()
  })
})
