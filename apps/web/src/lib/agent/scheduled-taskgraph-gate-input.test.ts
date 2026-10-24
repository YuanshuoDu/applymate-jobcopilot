import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Prisma } from '@prisma/client'
import { hashArtifactContent } from './artifacts/hash'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { scheduledTaskGraphAnalyzeCheckpointDigest } from './scheduled-taskgraph-gate-checkpoint'

const mocks = vi.hoisted(() => ({ session: vi.fn(), jobs: vi.fn(), resume: vi.fn(), facts: vi.fn(), versions: vi.fn(), heads: vi.fn(), graph: vi.fn(), tasks: vi.fn(), events: vi.fn(), queryRaw: vi.fn(), gateHistory: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  agentSession: { findFirst: mocks.session }, job: { findMany: mocks.jobs }, resume: { findFirst: mocks.resume },
  personaFact: { findMany: mocks.facts }, agentArtifactVersion: { findMany: mocks.versions }, agentArtifact: { findMany: mocks.heads },
  agentItem: { findFirst: mocks.graph }, subAgentTask: { findMany: mocks.tasks }, agentEvent: { findMany: mocks.events },
  $queryRaw: mocks.queryRaw,
} }))
vi.mock('./scheduled-taskgraph-gate-history', async importOriginal => ({
  ...await importOriginal<typeof import('./scheduled-taskgraph-gate-history')>(),
  scheduledTaskGraphGateHistoryIsCurrent: mocks.gateHistory,
}))

import { isScheduledTaskGraphGateProofCurrent, loadScheduledTaskGraphGateInput, scheduledTaskGraphAnalyzeCheckpointForGate, type ScheduledTaskGraphGateInputRequest } from './scheduled-taskgraph-gate-input'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'lease-1', turnLeaseVersion: 4, executionId: 'execution-1', executionAttemptCount: 1 }
const snapshot = { schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
  minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false }
const jobRow = {
  id: 'job-1', userId: owner.userId, company: 'Example', role: 'Engineer', location: 'Dublin', status: 'saved', score: null,
  url: 'https://jobs.example.test/1', source: 'greenhouse', salary: '€80k', description: 'Build reliable systems', keywords: 'TypeScript',
  coverLetter: null, createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z'),
} as unknown as Job
const resume = { id: 'resume-1', name: 'Base resume', kind: 'base', origin: 'manual', isDefault: true,
  content: { summary: 'Designed reliable systems', skills: ['TypeScript'] },
  createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z') }
const fact = { id: 'fact-1', key: 'experience', category: 'experience', value: 'Built reliable services', source: 'resume',
  sourceRef: 'resume:source-1', confidence: 0.9, allowedUses: ['cover_letter'] }
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`
const resumeBody = { paragraphs: ['Tailored systems engineer'] }
const coverLetterBody = 'Dear Example, I build reliable systems.'
const reference = (artifactId: string, content: unknown) => ({ artifactId, version: 1,
  contentHash: hashArtifactContent(content), sourceDigest: sourceDigest(jobRow, resume, [fact]) })

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function resultDigest(value: Record<string, unknown>): string {
  const projected = { schemaVersion: value.schemaVersion, role: value.role, status: value.status, taskId: value.taskId,
    attemptCount: value.attemptCount, snapshotDigest: value.snapshotDigest, checkpointDigest: value.checkpointDigest, jobs: value.jobs, materials: value.materials }
  return createHash('sha256').update(canonicalJson(projected), 'utf8').digest('hex')
}
const graphNodes = [
  { key: 'scout', taskId: 'scout-task', templateId: 'scout', depth: 1, dependsOn: [], verificationDisposition: 'typed', verification: { role: 'scout', criteria: [{ id: 'candidate-count' }] } },
  { key: 'analyst', taskId: 'analyst-task', templateId: 'analyst', depth: 2, dependsOn: ['scout'], verificationDisposition: 'typed', verification: { role: 'analyst', criteria: [{ id: 'source-match' }] } },
  { key: 'prepare', taskId: 'prepare-task', templateId: 'prepare', depth: 3, dependsOn: ['analyst'], verificationDisposition: 'specialized' },
]
const completionNodes = (digest: string) => [
  { taskId: 'scout-task', attemptCount: 1, role: 'scout', taskType: 'job_discovery', status: 'completed', verification: 'passed', dependsOnTaskIds: [] },
  { taskId: 'analyst-task', attemptCount: 1, role: 'analyst', taskType: 'job_analysis', status: 'completed', verification: 'passed', dependsOnTaskIds: ['scout-task'] },
  { taskId: 'prepare-task', attemptCount: 1, role: 'prepare', taskType: 'scheduled_application_prepare', status: 'completed', verification: 'passed', dependsOnTaskIds: ['analyst-task'], tool: 'scheduled.application.prepare@1', resultDigest: digest },
]
function makeProof(result: Record<string, unknown>, evidenceDigest: string) {
  const stable = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, result.snapshotDigest, evidenceDigest, result.checkpointDigest, 9, 10]
  const receipt = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1', owner,
    continuationKey: `scheduled-taskgraph:sha256:${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex')}`,
    snapshotDigest: result.snapshotDigest, evidenceDigest, checkpointDigest: result.checkpointDigest, analyzeGraphRevision: 9, prepareScheduleRevision: 10 }
  const nodes = completionNodes(resultDigest(result))
  return { receipt, completion: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1', graphRevision: 11, nodes,
    wait: { waitId: 'wait-prepare', status: 'ready', mode: 'all', targetTaskIds: ['prepare-task'], matchedTaskIds: ['prepare-task'] } }, result }
}
function taskRows(proof: ReturnType<typeof makeProof>, attestation: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = ['scout', 'analyst'].map((role, index) => {
    const graphNode = graphNodes[index]!, expected = recordForTest(attestation[role])
    return { id: graphNode.taskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
      status: 'completed', role, taskType: index ? 'job_analysis' : 'job_discovery', attemptCount: 1, failureReason: null,
      result: { status: 'completed', taskGraphVerificationReport: { verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', status: 'passed',
        reasonCode: 'criteria_met', evidenceDigest: 'e'.repeat(64), resultDigest: expected.resultDigest,
        criteria: [{ criterionId: index ? 'source-match' : 'candidate-count', status: 'passed', reasonCode: 'criteria_met' }] } } }
  })
  const completion = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1', graphRevision: proof.completion.graphRevision, nodes: proof.completion.nodes }
  return [{ id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: null,
    attemptCount: owner.rootAttemptCount, status: 'running', failureReason: null }, ...rows, { id: 'prepare-task', sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, status: 'completed', role: 'prepare', taskType: 'scheduled_application_prepare',
    attemptCount: 1, failureReason: null, result: { status: 'completed', structuredResult: proof.result,
      taskGraphScheduledPrepareProofFacts: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-proof-facts.v1',
        receipt: proof.receipt, completion, result: proof.result } } }]
}
function recordForTest(value: unknown): Record<string, unknown> { return value as Record<string, unknown> }

function sourceDigest(job: Job, resumeRow = resume, facts: typeof fact[] = [fact]): string {
  const jobSource = { id: job.id, company: job.company, role: job.role, location: job.location ?? null, status: job.status,
    score: job.score ?? null, url: job.url ?? null, source: job.source ?? null, salary: job.salary ?? null,
    description: job.description ?? null, keywords: job.keywords ?? null }
  const resumeSource = { id: resumeRow.id, name: resumeRow.name, kind: resumeRow.kind, origin: resumeRow.origin,
    isDefault: resumeRow.isDefault, content: resumeRow.content, createdAt: resumeRow.createdAt.toISOString(), updatedAt: resumeRow.updatedAt.toISOString() }
  const sources = [
    { sourceRef: `job:${job.id}`, content: jobSource }, { sourceRef: `resume:${resumeRow.id}`, content: resumeSource },
    ...facts.map((entry, index) => ({ sourceRef: `persona:${entry.id}`, content: { ...entry, rank: index + 1 } })),
  ].map(item => ({ sourceRef: item.sourceRef, contentHash: hashArtifactContent(item.content) })).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))
  return hashArtifactContent({ jobId: job.id, sources })
}

function artifactRows(kind: 'resume' | 'cover_letter', ref = reference(kind === 'resume' ? 'artifact-resume' : 'artifact-letter',
  kind === 'resume' ? resumeBody : coverLetterBody), content: unknown = kind === 'resume' ? resumeBody : coverLetterBody) {
  const refs = [`job:${jobRow.id}`, `resume:${resume.id}`, `persona:${fact.id}`].sort()
  const version = { id: `version-${kind}`, artifactId: ref.artifactId, version: ref.version, userId: owner.userId, sessionId: owner.sessionId,
    jobId: jobRow.id, artifactType: kind, content, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest,
    constraintHash: sha('b'), provenanceRefs: refs, evidenceRefs: refs, baseId: 'base-artifact', baseHash: sha('c'), taskId: 'prepare-task',
    toolCallId: `call-${kind}`, requestHash: sha('d') }
  const headContent = kind === 'cover_letter'
    ? {
        kind: 'agent_artifact_version', artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash,
      }
    : content
  const head = { id: ref.artifactId, userId: owner.userId, jobId: jobRow.id, artifactType: kind, lifecycle: 'draft', baseId: version.baseId,
    baseHash: version.baseHash, content: headContent, hash: ref.contentHash, constraintHash: version.constraintHash, provenanceRefs: refs,
    evidenceRefs: refs, version: ref.version }
  return { version, head, ref }
}

function setup() {
  const analyzeCheckpoint = {
    nextStage: 'prepare', scoutedJobs: [{ ...jobRow, coverLetter: null }], analysisFailed: 0,
    scoredJobs: [{ job: { ...jobRow, coverLetter: null }, score: 87, matchedKeywords: ['TypeScript'], missingKeywords: ['Kubernetes'],
      recommendation: 'Tailor the resume.', analysisFenceAt: '2026-10-19T12:00:00.123Z' }],
    scheduledTaskGraphContinuation: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1', key: `scheduled-taskgraph:sha256:${'f'.repeat(64)}`,
      owner, snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9, evidenceDigest: 'd'.repeat(64) },
  }
  const resumeArtifact = artifactRows('resume'), letterArtifact = artifactRows('cover_letter')
  const result = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', status: 'completed', taskId: 'prepare-task', attemptCount: 1,
    snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), checkpointDigest: scheduledTaskGraphAnalyzeCheckpointDigest(analyzeCheckpoint),
    jobs: [{ jobId: jobRow.id, status: 'prepared' }],
    materials: [{ jobId: jobRow.id, kind: 'resume', artifactRef: resumeArtifact.ref }, { jobId: jobRow.id, kind: 'cover_letter', artifactRef: letterArtifact.ref }] }
  const analyzeAttestation = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1',
    owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
    snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
    scout: { taskId: 'scout-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'a'.repeat(64) },
    analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'b'.repeat(64), dependsOnTaskIds: ['scout-task'] },
    evidenceDigest: 'd'.repeat(64) }
  const proof = makeProof(result, analyzeAttestation.evidenceDigest)
  const graph = { id: `task-graph-${createHash('sha256').update(owner.rootTaskId).digest('hex')}`, sessionId: owner.sessionId,
    turnId: owner.turnId, taskId: owner.rootTaskId, type: 'task_graph', revision: proof.completion.graphRevision,
    content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: graphNodes } }
  const input: ScheduledTaskGraphGateInputRequest = { owner, snapshot, analyzeCheckpoint, analyzeAttestation, prepareProof: proof }
  mocks.session.mockResolvedValue({ id: owner.sessionId })
  mocks.jobs.mockResolvedValue([jobRow])
  mocks.resume.mockResolvedValue(resume)
  mocks.facts.mockResolvedValue([fact])
  mocks.versions.mockResolvedValue([resumeArtifact.version, letterArtifact.version])
  mocks.heads.mockResolvedValue([resumeArtifact.head, letterArtifact.head])
  mocks.graph.mockResolvedValue(graph)
  mocks.tasks.mockResolvedValue(taskRows(proof, analyzeAttestation))
  mocks.events.mockResolvedValue([{ payload: proof.receipt }])
  return { input, result, proof, graph, resumeArtifact, letterArtifact, analyzeCheckpoint, analyzeAttestation }
}

function attachGate(input: ScheduledTaskGraphGateInputRequest, proof: ReturnType<typeof makeProof>, graph: Record<string, unknown>, attestation: Record<string, unknown>,
  overrides: { receipt?: Record<string, unknown>; wait?: Record<string, unknown> } = {}) {
  const gateTaskId = 'gate-task', continuationKey = String(proof.receipt.continuationKey)
  const marker = (input.analyzeCheckpoint as { scheduledTaskGraphContinuation: { key: string } }).scheduledTaskGraphContinuation
  const stableOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
  const receipt = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-gate-binding.v1', owner: stableOwner, continuationKey,
    snapshotDigest: proof.receipt.snapshotDigest, evidenceDigest: proof.receipt.evidenceDigest, checkpointDigest: proof.receipt.checkpointDigest,
    analyzeGraphRevision: proof.receipt.analyzeGraphRevision, prepareScheduleRevision: proof.receipt.prepareScheduleRevision,
    prepareWaitId: proof.completion.wait.waitId, gateTaskId, gateAppendRevision: proof.completion.graphRevision + 1, ...overrides.receipt }
  const eventKey = `scheduled-gate-binding:${createHash('sha256').update(JSON.stringify([continuationKey, gateTaskId]), 'utf8').digest('hex')}`
  const event = { itemId: null, taskId: null, actor: 'system', idempotencyKey: eventKey, payload: receipt, hasOutbox: false }
  const stepId = 'prepare-root-step', waitKey = `scheduled-prepare-dependency:${createHash('sha256').update(`${marker.key}\0${stepId}`, 'utf8').digest('hex')}`
  const wait = { id: receipt.prepareWaitId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, parentTaskId: owner.rootTaskId,
    stepId, idempotencyKey: waitKey, targetTaskIds: ['prepare-task'], mode: 'all', status: 'ready', matchedTaskIds: ['prepare-task'],
    result: { request: { targetTaskIds: ['prepare-task'], mode: 'all', timeoutMs: 86_400_000 } }, stepTaskId: owner.rootTaskId, stepAttempt: 1,
    ...overrides.wait }
  const gateNode = { key: 'gate', taskId: gateTaskId, templateId: 'gate', depth: 4, dependsOn: ['prepare'], verificationDisposition: 'specialized' }
  const content = graph.content as Record<string, unknown>; content.nodes = [...content.nodes as unknown[], gateNode]
  graph.revision = proof.completion.graphRevision + 2
  const rows = taskRows(proof, attestation)
  rows.push({ id: gateTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
    depth: 1, role: 'prepare', taskType: 'scheduled_taskgraph_gate', status: 'running', attemptCount: 1, maxAttempts: 3, failureReason: null,
    result: null, expectedOutputSchema: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', taskType: 'scheduled_taskgraph_gate' }, allowedActions: [] })
  mocks.tasks.mockResolvedValue(rows)
  mocks.queryRaw.mockResolvedValueOnce([event]).mockResolvedValueOnce([wait])
  mocks.gateHistory.mockResolvedValue(true)
  return { ...input, gate: { taskId: gateTaskId, attemptCount: 1, phase: 'running' as const } }
}

describe('scheduled TaskGraph Gate input reload', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
  })

  it.each(['prepare', 'gate', 'execute', 'audit'] as const)('locks the current graph and proof for a %s checkpoint', async stage => {
    const { input, graph } = setup()
    const recoveryInput = { ...input, analyzeCheckpoint: { ...(input.analyzeCheckpoint as Record<string, unknown>), nextStage: stage } }
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: graph.id }])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }, { id: 'scout-task' }, { id: 'analyst-task' }, { id: 'prepare-task' }])
      .mockResolvedValueOnce([{ id: 'receipt-event' }])
    const tx = { $queryRaw: mocks.queryRaw, agentItem: { findFirst: mocks.graph },
      subAgentTask: { findMany: mocks.tasks }, agentEvent: { findMany: mocks.events } } as unknown as Prisma.TransactionClient
    await expect(isScheduledTaskGraphGateProofCurrent(recoveryInput, tx)).resolves.toBe(true)
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3)
    expect(mocks.queryRaw.mock.invocationCallOrder[2]).toBeLessThan(mocks.graph.mock.invocationCallOrder[0]!)
  })

  it.each(['gate', 'execute', 'audit'] as const)('rebuilds persisted Analyze facts from a %s checkpoint', async stage => {
    const { input } = setup()
    const analyzeCheckpoint = { ...(input.analyzeCheckpoint as Record<string, unknown>), nextStage: stage }
    await expect(loadScheduledTaskGraphGateInput({ ...input, analyzeCheckpoint })).resolves.toMatchObject({
      packages: [{ userId: owner.userId, sessionId: owner.sessionId, jobId: jobRow.id }],
    })
    expect(scheduledTaskGraphAnalyzeCheckpointForGate(analyzeCheckpoint)).toMatchObject({ nextStage: 'prepare' })
  })

  it('rejects checkpoints outside the scheduled Gate recovery stages', async () => {
    const { input } = setup()
    await expect(loadScheduledTaskGraphGateInput({ ...input, analyzeCheckpoint: { ...(input.analyzeCheckpoint as Record<string, unknown>), nextStage: 'completed' } }))
      .resolves.toBeNull()
    expect(mocks.graph).not.toHaveBeenCalled()
  })

  it('rebuilds packages from persisted scores and exact owner-scoped artifact versions', async () => {
    const { input } = setup()
    const loaded = await loadScheduledTaskGraphGateInput(input)
    expect(loaded?.packages).toHaveLength(1)
    expect(loaded?.packages[0]).toMatchObject({ userId: owner.userId, sessionId: owner.sessionId, jobId: jobRow.id,
      package: { score: 87, matchedKeywords: ['TypeScript'], tailoredResumeId: 'artifact-resume',
        tailoredResumeArtifact: { version: 1, sourceDigest: sourceDigest(jobRow, resume, [fact]) },
        coverLetter: coverLetterBody, coverLetterId: 'artifact-letter' } })
    expect(loaded?.materials.map(row => [row.kind, row.artifactRef.artifactId])).toEqual([
      ['resume', 'artifact-resume'], ['cover_letter', 'artifact-letter'],
    ])
    expect(mocks.versions).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: owner.userId, sessionId: owner.sessionId }) }))
  })

  it('rejects a TaskGraph revision that changes after Worker completion proof and before Gate hydration', async () => {
    const { input, graph, proof } = setup()
    graph.revision = proof.completion.graphRevision + 1
    await expect(loadScheduledTaskGraphGateInput(input)).resolves.toBeNull()
    expect(mocks.jobs).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('binds Gate registration to the exact ready Prepare wait and its owning step', async () => {
    const valid = setup()
    const marker = (valid.input.analyzeCheckpoint as { scheduledTaskGraphContinuation: { key: string } }).scheduledTaskGraphContinuation
    expect(marker.key).not.toBe(valid.proof.receipt.continuationKey)
    await expect(loadScheduledTaskGraphGateInput(attachGate(valid.input, valid.proof, valid.graph, valid.analyzeAttestation)))
      .resolves.toMatchObject({ packages: [{ jobId: jobRow.id }] })

    mocks.jobs.mockClear()
    const mismatched = setup()
    const request = attachGate(mismatched.input, mismatched.proof, mismatched.graph, mismatched.analyzeAttestation,
      { wait: { stepTaskId: 'foreign-root' } })
    await expect(loadScheduledTaskGraphGateInput(request)).resolves.toBeNull()
    expect(mocks.jobs).not.toHaveBeenCalled()

    mocks.jobs.mockClear()
    mocks.queryRaw.mockClear()
    const wrongWait = setup()
    const wrongRequest = attachGate(wrongWait.input, wrongWait.proof, wrongWait.graph, wrongWait.analyzeAttestation,
      { receipt: { prepareWaitId: 'not-the-Prepare-wait' } })
    await expect(loadScheduledTaskGraphGateInput(wrongRequest)).resolves.toBeNull()
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1)
  })

  it('rechecks the root attempt after package hydration before Gate admission', async () => {
    const { input, graph, proof, analyzeAttestation } = setup()
    const rows = taskRows(proof, analyzeAttestation)
    mocks.tasks.mockResolvedValue(rows)
    mocks.jobs.mockImplementationOnce(async () => {
      rows[0] = { ...rows[0], attemptCount: owner.rootAttemptCount + 1 }
      return [jobRow]
    })
    await expect(loadScheduledTaskGraphGateInput(input)).resolves.toMatchObject({ packages: [{ jobId: jobRow.id }] })
    mocks.queryRaw.mockResolvedValueOnce([{ id: graph.id }]).mockResolvedValueOnce(rows.map(row => ({ id: row.id })))
      .mockResolvedValueOnce([{ id: 'receipt-event' }])
    const tx = { $queryRaw: mocks.queryRaw, agentItem: { findFirst: mocks.graph },
      subAgentTask: { findMany: mocks.tasks }, agentEvent: { findMany: mocks.events } } as unknown as Prisma.TransactionClient
    await expect(isScheduledTaskGraphGateProofCurrent(input, tx)).resolves.toBe(false)
  })

  it.each(['failed', 'cancelled'])('rejects a %s root before loading package sources', async status => {
    const { input, proof, analyzeAttestation } = setup()
    const rows = taskRows(proof, analyzeAttestation)
    rows[0] = { ...rows[0], status, failureReason: 'root no longer owns this scheduled continuation' }
    mocks.tasks.mockResolvedValueOnce(rows)
    await expect(loadScheduledTaskGraphGateInput(input)).resolves.toBeNull()
    expect(mocks.jobs).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('rejects a running root that has a failure reason', async () => {
    const { input, proof, analyzeAttestation } = setup()
    const rows = taskRows(proof, analyzeAttestation)
    rows[0] = { ...rows[0], failureReason: 'root attempt failed' }
    mocks.tasks.mockResolvedValueOnce(rows)
    await expect(loadScheduledTaskGraphGateInput(input)).resolves.toBeNull()
    expect(mocks.jobs).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('fails closed for missing or ambiguous immutable versions', async () => {
    const missing = setup()
    mocks.versions.mockResolvedValueOnce([])
    await expect(loadScheduledTaskGraphGateInput(missing.input)).resolves.toBeNull()
    const ambiguous = setup()
    mocks.versions.mockResolvedValueOnce([ambiguous.resumeArtifact.version, ambiguous.resumeArtifact.version, ambiguous.letterArtifact.version])
    await expect(loadScheduledTaskGraphGateInput(ambiguous.input)).resolves.toBeNull()
  })

  it('rejects changed content, stale source digests, and provenance outside current sources', async () => {
    const changedContent = setup()
    mocks.versions.mockResolvedValueOnce([{ ...changedContent.resumeArtifact.version, content: { summary: 'changed' } }, changedContent.letterArtifact.version])
    await expect(loadScheduledTaskGraphGateInput(changedContent.input)).resolves.toBeNull()
    const staleSources = setup()
    mocks.jobs.mockResolvedValueOnce([{ ...jobRow, description: 'Changed job source' }])
    await expect(loadScheduledTaskGraphGateInput(staleSources.input)).resolves.toBeNull()
    const foreignProvenance = setup()
    mocks.versions.mockResolvedValueOnce([{ ...foreignProvenance.resumeArtifact.version, provenanceRefs: ['foreign:source'] }, foreignProvenance.letterArtifact.version])
    await expect(loadScheduledTaskGraphGateInput(foreignProvenance.input)).resolves.toBeNull()
  })

  it('rejects wrong task attempts and materials for skipped or unknown jobs', async () => {
    const wrongTask = setup()
    mocks.versions.mockResolvedValueOnce([{ ...wrongTask.resumeArtifact.version, taskId: 'other-task' }, wrongTask.letterArtifact.version])
    await expect(loadScheduledTaskGraphGateInput(wrongTask.input)).resolves.toBeNull()
    const skipped = setup()
    skipped.result.jobs[0]!.status = 'skipped'
    await expect(loadScheduledTaskGraphGateInput(skipped.input)).resolves.toBeNull()
    const unknownJob = setup()
    unknownJob.result.materials[0]!.jobId = 'job-foreign'
    await expect(loadScheduledTaskGraphGateInput(unknownJob.input)).resolves.toBeNull()
  })

  it('accepts a verified zero-eligible result without loading materials', async () => {
    const { input, result, analyzeAttestation } = setup()
    const emptyCheckpoint = { ...(input.analyzeCheckpoint as Record<string, unknown>), scoutedJobs: [], scoredJobs: [], analysisFailed: 0 }
    const emptyResult = { ...result, jobs: [], materials: [], checkpointDigest: scheduledTaskGraphAnalyzeCheckpointDigest(emptyCheckpoint)! }
    const proof = makeProof(emptyResult, analyzeAttestation.evidenceDigest)
    mocks.tasks.mockResolvedValue(taskRows(proof, analyzeAttestation))
    mocks.events.mockResolvedValue([{ payload: proof.receipt }])
    await expect(loadScheduledTaskGraphGateInput({ ...input, analyzeCheckpoint: emptyCheckpoint, prepareProof: proof }))
      .resolves.toEqual({ packages: [], materials: [] })
    expect(mocks.versions).not.toHaveBeenCalled()
  })
})
