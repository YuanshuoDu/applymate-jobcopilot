import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Job } from '@prisma/client'
import { hashArtifactContent } from './artifacts/hash'
import {
  buildScheduledTaskGraphGateCheckpoint,
  scheduledTaskGraphAnalyzeCheckpointDigest,
  type ScheduledTaskGraphGateCheckpointInput,
} from './scheduled-taskgraph-gate-checkpoint'
import {
  buildScheduledTaskGraphPrepareCheckpoint,
  scheduledAutomationSnapshotDigest,
  type ScheduledTaskGraphPipelineOwner,
} from './scheduled-taskgraph-pipeline-checkpoint'
import type { ApplicationPackage, ScoredJob, StageResult, AnalyzeOutput } from './types'

const ids = ['c' + '1'.repeat(24), 'c' + '2'.repeat(24)]
const owner: ScheduledTaskGraphPipelineOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 3,
  turnLeaseOwnerId: 'lease-owner-1', turnLeaseVersion: 7, executionId: 'execution-1', executionAttemptCount: 5,
}
const snapshot = {
  schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Engineer'],
  targetLocations: ['Dublin'], minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false,
}
const snapshotDigest = scheduledAutomationSnapshotDigest(snapshot)
const continuationKey = 'scheduled-taskgraph:sha256:' + 'f'.repeat(64)
const analyzeOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
const analyzeAttestation = {
  schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1', owner: analyzeOwner, snapshotDigest, graphRevision: 9,
  scout: { taskId: 'scout-task', attemptCount: 2, status: 'completed', verification: 'passed', resultDigest: 'a'.repeat(64), candidateJobIds: ids,
    discoveryReceipt: { status: 'complete', taskId: 'scout-task', attemptCount: 2, completedCalls: 1, candidateCount: ids.length,
      providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: 'b'.repeat(64) } },
  analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'c'.repeat(64),
    dependsOnTaskIds: ['scout-task'], jobIds: [...ids].reverse() }, evidenceDigest: 'd'.repeat(64),
}

function job(id: string, userId = owner.userId): Job { return { id, userId, title: `Job ${id}` } as unknown as Job }
function scored(row: Job, score: number): ScoredJob {
  return { job: row, score, matchedKeywords: ['TypeScript'], missingKeywords: ['Kubernetes'],
    recommendation: 'Tailor the CV.', analysisFenceAt: '2026-10-19T12:00:00.123Z' }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function prepareResultDigest(result: Record<string, unknown>): string {
  const projection = { schemaVersion: result.schemaVersion, role: result.role, status: result.status, snapshotDigest: result.snapshotDigest,
    checkpointDigest: result.checkpointDigest, jobs: result.jobs, materials: result.materials }
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex')
}
function analyzeResult(rows: readonly Job[]): StageResult<AnalyzeOutput> {
  return { stage: 'analyze', ok: true, data: { scoredJobs: rows.map((row, index) => scored(row, index ? 73 : 87)), failed: 0 },
    metrics: { durationMs: 1, count: rows.length } }
}
function prepared(overrides: Partial<typeof snapshot> = {}, liveOwner: ScheduledTaskGraphPipelineOwner = owner) {
  const policySnapshot = { ...snapshot, ...overrides }
  const policyDigest = scheduledAutomationSnapshotDigest(policySnapshot)
  const policyAttestation = { ...analyzeAttestation, owner: { ...analyzeOwner, turnLeaseOwnerId: liveOwner.turnLeaseOwnerId, turnLeaseVersion: liveOwner.turnLeaseVersion }, snapshotDigest: policyDigest }
  const jobs = ids.map(id => job(id))
  const prior = buildScheduledTaskGraphPrepareCheckpoint({ owner: liveOwner, snapshot: policySnapshot, attestation: policyAttestation, ownedJobs: jobs, analyzeResult: analyzeResult(jobs) })
  const persisted = JSON.parse(JSON.stringify(prior.checkpoint)) as Record<string, unknown>
  const claim = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key: prior.continuationKey, claimToken: 'claim-secret', owner: { ...liveOwner },
    claimedAt: '2026-10-19T12:00:00.123Z', leaseExpiresAt: '2099-10-19T12:10:00.123Z' }
  persisted.scheduledTaskGraphClaim = claim
  const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(persisted)!
  const materials = jobs.map((row, index) => ({ userId: owner.userId, sessionId: owner.sessionId, jobId: row.id, kind: 'resume' as const,
    artifactRef: { artifactId: `resume-${index + 1}`, version: 2, contentHash: `sha256:${String(index + 1).repeat(64)}`, sourceDigest: `sha256:${String(index + 3).repeat(64)}` } }))
  const packages: ScheduledTaskGraphGateCheckpointInput['packages'][number][] = jobs.map((row, index) => {
    const ref = materials[index]!.artifactRef
    return { userId: owner.userId, sessionId: owner.sessionId, jobId: row.id,
      package: { ...scored(row, index ? 73 : 87), tailoredResumeId: ref.artifactId, tailoredResumeName: 'Resume.pdf',
        tailoredResumeArtifact: ({ id: ref.artifactId, kind: 'resume', lifecycle: 'draft', version: ref.version, hash: ref.contentHash, sourceDigest: ref.sourceDigest,
          baseArtifactId: 'base-resume', baseHash: 'sha256:' + 'a'.repeat(64), constraintHash: 'sha256:' + 'b'.repeat(64),
          provenance: [{ sourceType: 'resume', sourceRef: 'resume:base', evidenceHash: 'sha256:' + 'c'.repeat(64) }] } as ApplicationPackage['tailoredResumeArtifact']) } }
  })
  const result = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', status: 'completed', taskId: 'prepare-task', attemptCount: 1,
    snapshotDigest: policyDigest, checkpointDigest, jobs: ids.map(jobId => ({ jobId, status: 'prepared' })),
    materials: materials.map(item => ({ jobId: item.jobId, kind: item.kind, artifactRef: item.artifactRef })) }
  const resultDigest = prepareResultDigest(result)
  const stableKeyProjection = [liveOwner.userId, liveOwner.sessionId, liveOwner.turnId, liveOwner.rootTaskId, liveOwner.rootAttemptCount,
    liveOwner.executionId, liveOwner.executionAttemptCount, policyDigest, policyAttestation.evidenceDigest, checkpointDigest, 9, 10]
  const stableContinuationKey = `scheduled-taskgraph:sha256:${createHash('sha256').update(JSON.stringify(stableKeyProjection), 'utf8').digest('hex')}`
  const proof = {
    receipt: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1', owner, continuationKey: stableContinuationKey,
      snapshotDigest: policyDigest, evidenceDigest: policyAttestation.evidenceDigest, checkpointDigest, analyzeGraphRevision: 9, prepareScheduleRevision: 10 },
    completion: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1', graphRevision: 11,
      nodes: [
        { taskId: 'scout-task', attemptCount: 2, role: 'scout', taskType: 'job_discovery', status: 'completed', verification: 'passed', dependencies: [] },
        { taskId: 'analyst-task', attemptCount: 1, role: 'analyst', taskType: 'job_analysis', status: 'completed', verification: 'passed', dependencies: ['scout-task'] },
        { taskId: 'prepare-task', attemptCount: 1, role: 'prepare', taskType: 'scheduled_application_prepare', tool: 'scheduled.application.prepare@1',
          status: 'completed', verification: 'passed', resultDigest, dependencies: ['analyst-task'] },
      ], wait: { waitId: 'wait-prepare', status: 'ready', mode: 'all', targetTaskIds: ['prepare-task'], matchedTaskIds: ['prepare-task'] } },
    result,
  }
  return { jobs, prior, persisted, checkpointDigest, materials, packages, proof, snapshot: policySnapshot, attestation: policyAttestation, liveOwner }
}
function attachCoverLetter(value: ReturnType<typeof prepared>, body: string): void {
  const letterRef = { artifactId: 'letter-1', version: 1, contentHash: hashArtifactContent(body), sourceDigest: value.materials[0]!.artifactRef.sourceDigest }
  const letterArtifact = {
    id: letterRef.artifactId, kind: 'cover_letter', lifecycle: 'draft', version: letterRef.version, hash: letterRef.contentHash,
    sourceDigest: letterRef.sourceDigest, baseArtifactId: 'base-letter', baseHash: 'sha256:' + 'a'.repeat(64),
    constraintHash: 'sha256:' + 'b'.repeat(64),
    provenance: [{ sourceType: 'resume', sourceRef: 'resume:base', evidenceHash: 'sha256:' + 'c'.repeat(64) }],
  } as unknown as NonNullable<ApplicationPackage['coverLetterArtifact']>
  const firstPackage = value.packages[0]!
  value.packages[0] = { ...firstPackage, package: { ...firstPackage.package, coverLetter: body,
    coverLetterId: letterRef.artifactId, coverLetterArtifact: letterArtifact } }
  ;(value.materials as unknown as ScheduledTaskGraphGateCheckpointInput['materials'][number][]).push({ userId: owner.userId,
    sessionId: owner.sessionId, jobId: ids[0]!, kind: 'cover_letter', artifactRef: letterRef })
  ;(value.proof.result.materials as unknown as Array<{ jobId: string; kind: string; artifactRef: typeof letterRef }>).push({
    jobId: ids[0]!, kind: 'cover_letter', artifactRef: letterRef })
  value.proof.completion.nodes[2]!.resultDigest = prepareResultDigest(value.proof.result)
}
function input(overrides: Partial<ScheduledTaskGraphGateCheckpointInput> = {}, value = prepared()): ScheduledTaskGraphGateCheckpointInput {
  return { analyze: { owner: value.liveOwner, snapshot: value.snapshot, attestation: value.attestation, ownedJobs: value.jobs, persistedCheckpoint: value.persisted, activeClaimToken: 'claim-secret' },
    proof: value.proof, packages: value.packages, materials: value.materials, ...overrides }
}
function retainPreparedJobs(value: ReturnType<typeof prepared>, selected: readonly string[]): void {
  const included = new Set(selected)
  value.proof.result.jobs = value.proof.result.jobs.filter(row => included.has(row.jobId))
  value.proof.result.materials = value.proof.result.materials.filter(row => included.has(row.jobId))
  value.packages = value.packages.filter(row => included.has(row.jobId))
  value.materials = value.materials.filter(row => included.has(row.jobId))
  value.proof.completion.nodes[2]!.resultDigest = prepareResultDigest(value.proof.result)
}

describe('scheduled TaskGraph Prepare to Gate checkpoint', () => {
  it('hashes only the validated Analyze projection and builds Gate from trusted packages', () => {
    const value = prepared()
    const digest = scheduledTaskGraphAnalyzeCheckpointDigest(value.persisted)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    const gate = buildScheduledTaskGraphGateCheckpoint(input({}, value))
    expect(gate?.checkpoint.nextStage).toBe('gate')
    expect(gate?.checkpoint.scoredJobs?.map(row => row.score)).toEqual([73, 87])
    expect(gate?.checkpoint.scoredJobs?.[0]?.job).toEqual({ ...value.jobs[1], coverLetter: null })
    expect(gate?.packages.map(row => row.job.id)).toEqual([ids[1], ids[0]])
    expect(gate?.packages[0]?.tailoredResumeArtifact?.id).toBe('resume-2')
    expect(gate?.checkpoint.scheduledTaskGraphClaim).toEqual(value.persisted.scheduledTaskGraphClaim)
    expect(gate?.checkpoint.scheduledTaskGraphContinuation).toEqual(value.prior.checkpoint.scheduledTaskGraphContinuation)
    const changedJobBody = { ...value.persisted, scoutedJobs: (value.persisted.scoutedJobs as Job[]).map(row => ({ ...row, title: 'Changed body' })) }
    expect(scheduledTaskGraphAnalyzeCheckpointDigest(changedJobBody)).toBe(digest)
  })

  it('keeps material bodies out of the serializable checkpoint and returns packages separately', () => {
    const value = prepared()
    value.persisted.privateWorkerBody = 'must not continue into the pipeline'
    const letterBody = 'private cover letter body'
    attachCoverLetter(value, letterBody)
    const gate = buildScheduledTaskGraphGateCheckpoint(input({}, value))
    expect(gate?.checkpoint.nextStage).toBe('gate')
    expect(gate?.checkpoint).not.toHaveProperty('preparedPackages')
    expect(JSON.stringify(gate?.checkpoint)).not.toContain('must not continue into the pipeline')
    expect(JSON.stringify(gate?.checkpoint)).not.toContain(letterBody)
    expect(gate?.packages.find(row => row.job.id === ids[0])?.coverLetter).toBe(letterBody)
    expect(gate?.packages).toHaveLength(2)
  })

  it('rejects a cover-letter body that is not backed by the exact immutable material reference', () => {
    const value = prepared()
    value.packages[0] = { ...value.packages[0]!, package: { ...value.packages[0]!.package, coverLetter: 'unreferenced private letter' } }
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value))).toBeNull()
  })

  it('rejects a cover-letter body changed while retaining the immutable material reference', () => {
    const value = prepared()
    attachCoverLetter(value, 'private cover letter body')
    value.packages[0] = { ...value.packages[0]!, package: { ...value.packages[0]!.package, coverLetter: 'changed cover letter body' } }
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value))).toBeNull()
  })

  it('accepts a completed result with a skipped eligible job and no skipped package or material', () => {
    const value = prepared()
    value.proof.result.jobs[1]!.status = 'skipped'
    value.proof.result.materials = value.proof.result.materials.filter(row => row.jobId !== ids[1])
    value.packages = value.packages.filter(row => row.jobId !== ids[1])
    value.materials = value.materials.filter(row => row.jobId !== ids[1])
    value.proof.completion.nodes[2]!.resultDigest = prepareResultDigest(value.proof.result)
    const gate = buildScheduledTaskGraphGateCheckpoint(input({}, value))
    expect(gate?.packages.map(row => row.job.id)).toEqual([ids[0]])
  })

  it('uses the persisted minScore threshold when validating the Prepare job set', () => {
    const value = prepared({ minScore: 77 })
    retainPreparedJobs(value, [ids[0]])
    const gate = buildScheduledTaskGraphGateCheckpoint(input({}, value))
    expect(gate?.packages.map(row => row.job.id)).toEqual([ids[0]])
  })

  it('applies dailyCap to persisted Analyze row order before validating Prepare jobs', () => {
    const value = prepared({ dailyCap: 1 })
    retainPreparedJobs(value, [ids[1]])
    const gate = buildScheduledTaskGraphGateCheckpoint(input({}, value))
    expect(gate?.packages.map(row => row.job.id)).toEqual([ids[1]])
  })

  it('rejects a prepared job without exactly one resume material', () => {
    const value = prepared()
    value.proof.result.materials = []
    value.materials = []
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value))).toBeNull()
  })

  it.each([
    ['missing checkpoint', null],
    ['wrong stage', { ...prepared().persisted, nextStage: 'gate' }],
    ['sparse scores', { ...prepared().persisted, scoredJobs: Array(2) }],
    ['unaccounted Analyze candidate', { ...prepared().persisted, analysisFailed: 0, scoredJobs: (prepared().persisted.scoredJobs as object[]).slice(0, 1) }],
    ['out of range score', { ...prepared().persisted, scoredJobs: (prepared().persisted.scoredJobs as object[]).map((row, index) => index ? row : { ...row, score: 101 }) }],
    ['unexpected score metadata', { ...prepared().persisted, scoredJobs: (prepared().persisted.scoredJobs as object[]).map(row => ({ ...row, coverLetter: 'must not be hashed' })) }],
  ])('returns no digest for %s', (_name, value) => expect(scheduledTaskGraphAnalyzeCheckpointDigest(value)).toBeNull())

  it('accepts an unscored Analyze candidate when the checkpoint explicitly counts its failure', () => {
    const value = prepared()
    value.persisted.analysisFailed = 1
    value.persisted.scoredJobs = (value.persisted.scoredJobs as object[]).slice(0, 1)
    expect(scheduledTaskGraphAnalyzeCheckpointDigest(value.persisted)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps Analyze digest and stable receipt key across a lease-only rebind', () => {
    const original = prepared()
    const reacquired = prepared({}, { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 })
    expect(scheduledTaskGraphAnalyzeCheckpointDigest(reacquired.persisted)).toBe(scheduledTaskGraphAnalyzeCheckpointDigest(original.persisted))
    expect(reacquired.proof.receipt.continuationKey).toBe(original.proof.receipt.continuationKey)

    const changedLineage = JSON.parse(JSON.stringify(original.persisted)) as Record<string, unknown>
    ;((changedLineage.scheduledTaskGraphContinuation as { owner: { executionAttemptCount: number } }).owner).executionAttemptCount += 1
    expect(scheduledTaskGraphAnalyzeCheckpointDigest(changedLineage)).not.toBe(scheduledTaskGraphAnalyzeCheckpointDigest(original.persisted))

    const changedEvidence = JSON.parse(JSON.stringify(original.persisted)) as Record<string, unknown>
    ;((changedEvidence.scoredJobs as Array<{ score: number }>)[0]!).score += 1
    expect(scheduledTaskGraphAnalyzeCheckpointDigest(changedEvidence)).not.toBe(scheduledTaskGraphAnalyzeCheckpointDigest(original.persisted))
  })

  it('accepts the stable Analyze receipt after lease reacquisition while checking the new live claim', () => {
    const liveOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
    const value = prepared({}, liveOwner)
    expect(value.proof.receipt.owner).toEqual(owner)
    expect(value.proof.receipt.continuationKey).not.toBe(value.prior.continuationKey)
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value))).not.toBeNull()
  })

  it('rejects a reacquired continuation with the old lease key or old live claim', () => {
    const oldLeaseKey = prepared().prior.continuationKey
    const liveOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
    const staleReceipt = prepared({}, liveOwner)
    staleReceipt.proof.receipt.continuationKey = oldLeaseKey
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, staleReceipt))).toBeNull()

    const staleClaim = prepared({}, liveOwner)
    ;(staleClaim.persisted.scheduledTaskGraphClaim as { owner: ScheduledTaskGraphPipelineOwner }).owner = { ...owner }
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, staleClaim))).toBeNull()
  })

  it.each([
    ['stale receipt', (value: ReturnType<typeof prepared>) => { value.proof.receipt.checkpointDigest = '0'.repeat(64) }],
    ['wrong owner', (value: ReturnType<typeof prepared>) => { value.proof.receipt.owner = { ...owner, userId: 'other-user' } }],
    ['old lease-bound continuation key', (value: ReturnType<typeof prepared>) => { value.proof.receipt.continuationKey = value.prior.continuationKey }],
    ['arbitrary stable-looking continuation key', (value: ReturnType<typeof prepared>) => { value.proof.receipt.continuationKey = continuationKey }],
    ['wrong evidence', (value: ReturnType<typeof prepared>) => { value.proof.receipt.evidenceDigest = 'e'.repeat(64) }],
    ['wrong Analyze revision', (value: ReturnType<typeof prepared>) => { value.proof.receipt.analyzeGraphRevision = 8 }],
    ['schedule before Analyze', (value: ReturnType<typeof prepared>) => { value.proof.receipt.prepareScheduleRevision = 9 }],
    ['completion before schedule', (value: ReturnType<typeof prepared>) => { value.proof.completion.graphRevision = 9 }],
    ['completion at schedule revision', (value: ReturnType<typeof prepared>) => { value.proof.completion.graphRevision = 10 }],
    ['wrong wait mode', (value: ReturnType<typeof prepared>) => { value.proof.completion.wait.mode = 'any' }],
    ['Prepare result task from another task', (value: ReturnType<typeof prepared>) => { value.proof.result.taskId = 'other-prepare-task' }],
    ['Prepare result from another attempt', (value: ReturnType<typeof prepared>) => { value.proof.result.attemptCount = 2 }],
    ['Prepare node task differs from result', (value: ReturnType<typeof prepared>) => { value.proof.completion.nodes[2]!.taskId = 'other-prepare-task'; value.proof.completion.wait.targetTaskIds = ['other-prepare-task']; value.proof.completion.wait.matchedTaskIds = ['other-prepare-task'] }],
    ['Prepare node attempt differs from result', (value: ReturnType<typeof prepared>) => { value.proof.completion.nodes[2]!.attemptCount = 2 }],
    ['Prepare node has a different result digest', (value: ReturnType<typeof prepared>) => { value.proof.completion.nodes[2]!.resultDigest = '0'.repeat(64) }],
    ['Prepare result payload changed after completion', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs[0]!.status = 'skipped' }],
    ['duplicate Prepare task identity', (value: ReturnType<typeof prepared>) => { value.proof.completion.nodes[2]!.taskId = 'analyst-task'; value.proof.completion.wait.targetTaskIds = ['analyst-task']; value.proof.completion.wait.matchedTaskIds = ['analyst-task'] }],
    ['extra proof identity', (value: ReturnType<typeof prepared>) => { (value.proof.result as Record<string, unknown>).userId = owner.userId }],
    ['extra proof body', (value: ReturnType<typeof prepared>) => { (value.proof.result as Record<string, unknown>).coverLetter = 'private text' }],
    ['partial top-level result', (value: ReturnType<typeof prepared>) => { value.proof.result.status = 'partial' }],
    ['failed per-job result', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs[0]!.status = 'failed' }],
    ['duplicate Prepare jobs', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs[1] = value.proof.result.jobs[0]! }],
    ['missing Prepare jobs', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs.pop() }],
    ['extra Prepare job', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs.push({ jobId: 'extra-job', status: 'prepared' }) }],
    ['malformed artifact ref', (value: ReturnType<typeof prepared>) => { value.proof.result.materials[0]!.artifactRef.contentHash = 'not-a-sha256' }],
    ['wrong artifact source digest', (value: ReturnType<typeof prepared>) => { value.proof.result.materials[0]!.artifactRef = { ...value.proof.result.materials[0]!.artifactRef, sourceDigest: 'sha256:' + '9'.repeat(64) } }],
    ['material for skipped job', (value: ReturnType<typeof prepared>) => { value.proof.result.jobs[1]!.status = 'skipped' }],
    ['missing artifact ref', (value: ReturnType<typeof prepared>) => { value.proof.result.materials.pop() }],
    ['duplicate artifact ref', (value: ReturnType<typeof prepared>) => { value.proof.result.materials[1] = value.proof.result.materials[0]! }],
    ['wrong Analyze score source', (value: ReturnType<typeof prepared>) => { value.packages[0]!.package.score = 99 }],
    ['wrong tailored keyword source', (value: ReturnType<typeof prepared>) => { value.packages[0]!.package.tailoredKeywords = ['invented'] }],
    ['foreign material owner', (value: ReturnType<typeof prepared>) => { value.materials[0]!.userId = 'other-user' }],
    ['missing scheduled execution claim', (value: ReturnType<typeof prepared>) => { delete value.persisted.scheduledTaskGraphClaim }],
    ['claim from another Turn', (value: ReturnType<typeof prepared>) => { (value.persisted.scheduledTaskGraphClaim as { owner: Record<string, unknown> }).owner.turnId = 'other-turn' }],
    ['stale claim after token rotation', (value: ReturnType<typeof prepared>) => { (value.persisted.scheduledTaskGraphClaim as { claimToken: string }).claimToken = 'old-token' }],
    ['empty package provenance', (value: ReturnType<typeof prepared>) => { (value.packages[0]!.package.tailoredResumeArtifact as unknown as Record<string, unknown>).provenance = [] }],
    ['package provenance with an invalid hash', (value: ReturnType<typeof prepared>) => { const summary = value.packages[0]!.package.tailoredResumeArtifact as unknown as Record<string, unknown>; (summary.provenance as Array<Record<string, unknown>>)[0]!.evidenceHash = 'invalid' }],
    ['package source digest differs from immutable artifact version', (value: ReturnType<typeof prepared>) => { (value.packages[0]!.package.tailoredResumeArtifact as unknown as Record<string, unknown>).sourceDigest = 'sha256:' + '9'.repeat(64) }],
    ['wrong dependency', (value: ReturnType<typeof prepared>) => { value.proof.completion.nodes[2]!.dependencies = ['scout-task'] }],
  ])('rejects %s', (_name, mutate) => {
    const value = prepared()
    mutate(value)
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value))).toBeNull()
  })

  it('rejects a persisted checkpoint that was not already at Prepare', () => {
    const value = prepared()
    const request = input({}, value)
    const mismatched = { ...request, analyze: { ...request.analyze, persistedCheckpoint: { ...value.persisted, nextStage: 'analyze' } } }
    expect(buildScheduledTaskGraphGateCheckpoint(mismatched)).toBeNull()
  })

  it('rejects conversion when the checkpoint claim is no longer the active claim', () => {
    const request = input()
    const rotated = { ...request, analyze: { ...request.analyze, activeClaimToken: 'rotated-token' } }
    expect(buildScheduledTaskGraphGateCheckpoint(rotated)).toBeNull()
  })

  it('rejects conversion after the scheduled claim lease expires', () => {
    const value = prepared()
    ;(value.persisted.scheduledTaskGraphClaim as { leaseExpiresAt: string }).leaseExpiresAt = '2026-10-20T12:00:00.000Z'
    expect(buildScheduledTaskGraphGateCheckpoint(input({}, value), Date.parse('2026-10-20T12:00:00.001Z'))).toBeNull()
  })
})
