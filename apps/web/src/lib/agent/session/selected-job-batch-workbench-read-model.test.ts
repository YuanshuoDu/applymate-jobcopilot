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
const correctionRef = { artifactId: 'artifact_1', version: 3, contentHash: `sha256:${'c'.repeat(64)}`, sourceDigest: refs[0]!.sourceDigest }
const initialReviewHash = `sha256:${'d'.repeat(64)}`
const correctionReviewHash = `sha256:${'e'.repeat(64)}`
type TestTaskRow = {
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; path: string
  role: 'writer' | 'reviewer'; taskType: 'cover_letter_draft' | 'cover_letter_review'; status: string
  goal: string; confidence: null; failureReason: null; result: unknown; context: unknown
  attemptCount: number; createdAt: Date; updatedAt: Date
}
const taskRows: TestTaskRow[] = selectedJobIds.flatMap((jobId, index) => {
  const makeResult = (role: 'writer' | 'reviewer') => ({ status: 'completed', stepCount: 2, toolCallCount: 1,
    finalItemId: null, finalText: 'PRIVATE_MODEL_TEXT', structuredResult: {
      schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', artifactRef: refs[index],
      ...(role === 'reviewer' ? { reviewStatus: 'passed', reviewHash: index === 0 ? initialReviewHash : `sha256:${String(index + 5).repeat(64)}` } : {}),
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

function object(value: unknown): Record<string, unknown> { return value as Record<string, unknown> }
function withRoleResult(row: TestTaskRow, fields: Record<string, unknown>): TestTaskRow {
  const envelope = object(row.result)
  return { ...row, result: { ...envelope, structuredResult: { ...object(envelope.structuredResult), ...fields } } }
}

function correctionRows(options: { writerStatus?: string; reviewerStatus?: string; reviewStatus?: string; initialReviewStatus?: string;
  correctionJob?: string; correctionRef?: typeof correctionRef } = {}): TestTaskRow[] {
  const initial = taskRows.map(row => row.id === 'reviewer_task_1'
    ? withRoleResult(row, { reviewStatus: options.initialReviewStatus ?? 'needs_revision', reviewHash: initialReviewHash }) : row)
  const writer = taskRows.find(row => row.id === 'writer_task_1')!
  const reviewer = taskRows.find(row => row.id === 'reviewer_task_1')!
  const ref = options.correctionRef ?? correctionRef
  const correctionWriter = withRoleResult({ ...writer, id: 'writer_task_1_correction', path: '/writer-1-correction',
    status: options.writerStatus ?? 'completed', context: { selectedJobPreparation: { jobId: options.correctionJob ?? 'job_1' } } }, { artifactRef: ref })
  const correctionReviewer = withRoleResult({ ...reviewer, id: 'reviewer_task_1_correction', path: '/reviewer-1-correction',
    status: options.reviewerStatus ?? 'completed', context: { selectedJobPreparation: { jobId: options.correctionJob ?? 'job_1' } } }, {
    artifactRef: ref, reviewStatus: options.reviewStatus ?? 'passed', reviewHash: correctionReviewHash,
  })
  return [...initial, correctionWriter, correctionReviewer]
}

function graphWithCorrection(): unknown {
  return { ...currentGraph, revision: 6, content: { ...currentGraph.content, nodes: [...currentNodes,
    { key: 'writer_1_correction', templateId: 'cover_letter_writer_slot_1', goal: 'private correction goal', successCriteria: ['revise'],
      dependsOn: ['reviewer_1'], depth: 3, taskId: 'writer_task_1_correction', verificationDisposition: 'specialized' },
    { key: 'reviewer_1_correction', templateId: 'cover_letter_reviewer_slot_1', goal: 'private correction review', successCriteria: ['review'],
      dependsOn: ['writer_1_correction'], depth: 4, taskId: 'reviewer_task_1_correction', verificationDisposition: 'specialized' },
  ] } }
}

function fixture(options: { queued?: boolean; rows?: readonly TestTaskRow[]; graph?: unknown | null; contextJob?: string; ownerMatch?: boolean; turnStatus?: string; rootStatus?: string; storedInput?: unknown; turnSource?: string; executionMode?: string } = {}) {
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
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter(row => where.id.in.includes(row.id))),
    },
    agentItem: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sourceGraph.id ? sourceGraph : where.id === currentGraph.id ? (options.graph === undefined ? currentGraph : options.graph) : null) },
    job: { findMany: vi.fn().mockImplementation(async ({ where, select }: { where: { id: { in: string[] } }; select: Record<string, boolean> }) =>
      where.id.in.map((id, index) => select.company ? { id, company: `Company ${index + 1}`, role: `Role ${index + 1}` } : { id })) },
    agentArtifactVersion: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: Record<string, string | number> }) => ({
      id: `version_${where.artifactId}_${where.version}`, ...where, userId: owner.userId, sessionId: owner.sessionId,
      artifactType: 'cover_letter', previousHash: where.artifactId === refs[0]!.artifactId && Number(where.version) > refs[0]!.version
        ? refs[0]!.contentHash : null,
    })) },
    agentArtifactReview: { findFirst: vi.fn().mockImplementation(async ({ where }: { where: Record<string, string | number> }) => ({
      ...where, currentSourceDigest: where.sourceDigest,
    })) },
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

  it('projects the verified correction as the effective pair and leaves the other Job on its initial pair', async () => {
    const test = fixture({ rows: correctionRows(), graph: graphWithCorrection(), turnStatus: 'completed', rootStatus: 'completed' })
    const result = await readSelectedJobBatchWorkbenchModel(test.database, owner)

    expect(result).toMatchObject({ status: 'completed', graph: { revision: 6 }, jobs: [
      { slotId: 'slot-1', status: 'completed', writer: { artifactRef: correctionRef }, reviewer: { reviewStatus: 'passed' } },
      { slotId: 'slot-2', status: 'completed', writer: { artifactRef: refs[1] }, reviewer: { reviewStatus: 'passed' } },
    ] })
    expect(JSON.stringify(result)).not.toContain(refs[0]!.contentHash)
    expect(JSON.stringify(result)).not.toContain(correctionReviewHash)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL_TEXT')
    expect(test.tx.agentArtifactVersion.findFirst).toHaveBeenCalledTimes(3)
    expect(test.tx.agentArtifactReview.findFirst).toHaveBeenCalledTimes(3)

    const stillNeedsRevision = await readSelectedJobBatchWorkbenchModel(fixture({ rows: correctionRows({ reviewStatus: 'needs_revision' }),
      graph: graphWithCorrection(), turnStatus: 'completed', rootStatus: 'completed' }).database, owner)
    expect(stillNeedsRevision?.jobs[0]).toMatchObject({ writer: { artifactRef: correctionRef }, reviewer: { reviewStatus: 'needs_revision' } })
  })

  it('keeps an unfinished or failed correction explicit without falling back to its initial artifact or review', async () => {
    const pending = await readSelectedJobBatchWorkbenchModel(fixture({ rows: correctionRows({ writerStatus: 'running', reviewerStatus: 'queued' }),
      graph: graphWithCorrection() }).database, owner)
    expect(pending).toMatchObject({ status: 'pending', jobs: [
      { slotId: 'slot-1', status: 'pending', writer: { status: 'pending' }, reviewer: { status: 'pending' } },
      { slotId: 'slot-2', status: 'completed', writer: { artifactRef: refs[1] }, reviewer: { reviewStatus: 'passed' } },
    ] })
    expect(pending?.jobs[0]).not.toHaveProperty('writer.artifactRef')
    expect(pending?.jobs[0]).not.toHaveProperty('reviewer.reviewStatus')

    const failed = await readSelectedJobBatchWorkbenchModel(fixture({ rows: correctionRows({ writerStatus: 'failed', reviewerStatus: 'cancelled' }),
      graph: graphWithCorrection() }).database, owner)
    expect(failed).toMatchObject({ status: 'partial', jobs: [
      { slotId: 'slot-1', status: 'failed', writer: { status: 'failed' }, reviewer: { status: 'failed' } },
      { slotId: 'slot-2', status: 'completed', writer: { artifactRef: refs[1] }, reviewer: { reviewStatus: 'passed' } },
    ] })
    expect(failed?.jobs[0]).not.toHaveProperty('writer.artifactRef')
    expect(failed?.jobs[0]).not.toHaveProperty('reviewer.reviewStatus')
  })

  it('requires the initial needs_revision receipt and same-material current source before exposing a correction', async () => {
    const unauthorized = fixture({ rows: correctionRows({ initialReviewStatus: 'passed' }), graph: graphWithCorrection() })
    expect(await readSelectedJobBatchWorkbenchModel(unauthorized.database, owner)).toBeNull()

    const crossJob = fixture({ rows: correctionRows({ correctionJob: 'job_2' }), graph: graphWithCorrection() })
    expect(await readSelectedJobBatchWorkbenchModel(crossJob.database, owner)).toBeNull()

    const staleSource = fixture({ rows: correctionRows(), graph: graphWithCorrection() })
    staleSource.tx.agentArtifactReview.findFirst.mockImplementation(async ({ where }: { where: Record<string, string | number> }) => ({
      ...where, currentSourceDigest: `sha256:${'f'.repeat(64)}`,
    }))
    expect(await readSelectedJobBatchWorkbenchModel(staleSource.database, owner)).toBeNull()
  })

  it('requires the exact next version to persist the initial artifact content hash as previousHash', async () => {
    const wrongChains = [
      { ...correctionRef, version: refs[0]!.version },
      { ...correctionRef, version: refs[0]!.version + 2 },
      { ...correctionRef, sourceDigest: `sha256:${'f'.repeat(64)}` },
    ]
    for (const ref of wrongChains) {
      const test = fixture({ rows: correctionRows({ correctionRef: ref }), graph: graphWithCorrection() })
      expect(await readSelectedJobBatchWorkbenchModel(test.database, owner)).toBeNull()
    }

    const wrongPreviousHash = fixture({ rows: correctionRows(), graph: graphWithCorrection() })
    wrongPreviousHash.tx.agentArtifactVersion.findFirst.mockImplementation(async ({ where }: { where: Record<string, string | number> }) => ({
      id: `version_${where.artifactId}_${where.version}`, ...where, userId: owner.userId, sessionId: owner.sessionId,
      artifactType: 'cover_letter', previousHash: Number(where.version) === correctionRef.version ? `sha256:${'f'.repeat(64)}` : null,
    }))
    expect(await readSelectedJobBatchWorkbenchModel(wrongPreviousHash.database, owner)).toBeNull()
  })

  it('preserves a verified initial stale review instead of treating it as a correction grant', async () => {
    const rows = taskRows.map(row => row.id === 'reviewer_task_1'
      ? withRoleResult(row, { reviewStatus: 'stale', reviewHash: initialReviewHash }) : row)
    const test = fixture({ rows })
    test.tx.agentArtifactReview.findFirst.mockImplementation(async ({ where }: { where: Record<string, string | number> }) => ({
      ...where, currentSourceDigest: `sha256:${'f'.repeat(64)}`,
    }))
    const result = await readSelectedJobBatchWorkbenchModel(test.database, owner)
    expect(result?.jobs[0]?.reviewer.reviewStatus).toBe('stale')
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
