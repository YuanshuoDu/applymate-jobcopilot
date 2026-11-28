import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  sourceFence: vi.fn(),
  jobFindFirst: vi.fn(),
  resumeFindFirst: vi.fn(),
}))

vi.mock('../source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

import {
  acceptAnalyze, AnalyzeSourceChangedError, assertAnalyzeModelInputsCurrent, attachAnalyzeSourceChangedClaims,
  buildScorePrompt, createAnalyzeSourceChangedErrorWithClaims, createAnalyzeSourceFingerprint,
  hasCompleteAnalyzeSourceFingerprints, isAnalyzeSourceFingerprint, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS,
  parseScoreResult, readAnalyzeSourceChangedClaims, validateAnalyzeSourceFingerprints,
} from './analyze-model-input'

const job = {
  id: 'job_1', userId: 'user_1', company: 'Example Co', role: 'Software Engineer', location: 'Dublin',
  description: 'TypeScript role.', source: 'agent', url: 'https://jobs.lever.co/example/123',
} as Job
const resumeContent = { summary: 'Candidate resume' }
const resumeText = '\nSUMMARY:\nCandidate resume'

function jobInputs(value: Job = job) {
  return {
    company: value.company, role: value.role, location: value.location, description: value.description,
    source: value.source, url: value.url,
  }
}

function transaction(): Prisma.TransactionClient {
  return {
    job: { findFirst: mocks.jobFindFirst },
    resume: { findFirst: mocks.resumeFindFirst },
  } as unknown as Prisma.TransactionClient
}

function resume(id = 'resume_1', content: unknown = resumeContent) {
  return { id, content }
}

async function checkInputs(tx = transaction()) {
  return assertAnalyzeModelInputsCurrent(tx, { userId: 'user_1', job, resumeId: 'resume_1', resumeText })
}

describe('Analyze model inputs', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.sourceFence.mockResolvedValue(undefined)
    mocks.jobFindFirst.mockResolvedValue(jobInputs())
    mocks.resumeFindFirst.mockResolvedValue(resume())
  })

  it('fences first, then reads the owner-scoped Job and selected Resume on the same transaction', async () => {
    const order: string[] = []
    const tx = transaction()
    mocks.sourceFence.mockImplementation(async (client: unknown, userIds: string[]) => {
      expect(client).toBe(tx)
      expect(userIds).toEqual(['user_1'])
      order.push('fence')
    })
    mocks.jobFindFirst.mockImplementation(async () => { order.push('job'); return jobInputs() })
    mocks.resumeFindFirst.mockImplementation(async () => { order.push('resume'); return resume() })

    const fingerprint = await checkInputs(tx)

    expect(order).toEqual(['fence', 'job', 'resume'])
    expect(isAnalyzeSourceFingerprint(fingerprint)).toBe(true)
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({
      where: { id: 'job_1', userId: 'user_1' },
      select: { company: true, role: true, location: true, description: true, source: true, url: true },
    })
    expect(mocks.resumeFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user_1', isDefault: true }, select: { id: true, content: true },
    })
  })

  it('uses the existing newest-created fallback only when no default Resume exists', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(resume())

    await checkInputs()

    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user_1', isDefault: true }, select: { id: true, content: true },
    })
    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(2, {
      where: { userId: 'user_1' }, orderBy: { createdAt: 'desc' }, select: { id: true, content: true },
    })
  })

  it.each([
    ['company', 'Changed Co'],
    ['role', 'Changed Role'],
    ['location', 'Cork'],
    ['description', 'Changed description'],
    ['source', 'manual'],
    ['url', 'https://jobs.lever.co/other/456'],
  ] as const)('rejects stale Job %s input before reading the Resume', async (field, value) => {
    mocks.jobFindFirst.mockResolvedValue({ ...jobInputs(), [field]: value })

    await expect(checkInputs()).rejects.toBeInstanceOf(AnalyzeSourceChangedError)

    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a missing or non-owned Job', async () => {
    mocks.jobFindFirst.mockResolvedValue(null)

    await expect(checkInputs()).rejects.toBeInstanceOf(AnalyzeSourceChangedError)

    expect(mocks.jobFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'job_1', userId: 'user_1' } }))
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
  })

  it('rejects when the current Resume selection has a different identity', async () => {
    mocks.resumeFindFirst.mockResolvedValue(resume('resume_2'))

    await expect(checkInputs()).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
  })

  it('rejects when the selected Resume text sent to the model has changed', async () => {
    mocks.resumeFindFirst.mockResolvedValue(resume('resume_1', { summary: 'Updated candidate resume' }))

    await expect(checkInputs()).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
  })

  it('fails closed on fence errors before reading source rows', async () => {
    const fenceFailure = new Error('source fence failed')
    mocks.sourceFence.mockRejectedValue(fenceFailure)

    await expect(checkInputs()).rejects.toBe(fenceFailure)

    expect(mocks.jobFindFirst).not.toHaveBeenCalled()
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
  })

  it('builds a canonical fingerprint that changes with any source field or the prompt resume excerpt', () => {
    const source = createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText })
    expect(source).toMatchObject({ version: 'agent-harness.v2.analyze-source-input.v1', digest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const promptDigest = createHash('sha256').update(resumeText.slice(0, 2_000), 'utf8').digest('hex')
    expect(source.digest).toBe(createHash('sha256').update(JSON.stringify([
      'agent-harness.v2.analyze-source-input.v1', 'agent-harness.v2.analyze-source-input.v1', 'user_1', job.id,
      jobInputs().company, jobInputs().role, jobInputs().location, jobInputs().description, jobInputs().source, jobInputs().url,
      'resume_1', promptDigest,
    ]), 'utf8').digest('hex'))
    expect(createAnalyzeSourceFingerprint({ userId: 'user_2', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText }).digest).not.toBe(source.digest)
    expect(createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: { ...jobInputs(), source: 'manual' }, resumeId: 'resume_1', resumeText }).digest).not.toBe(source.digest)
    expect(createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_2', resumeText }).digest).not.toBe(source.digest)
    expect(createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText: `${resumeText}!` }).digest).not.toBe(source.digest)
    const promptExcerpt = 'r'.repeat(2_000)
    expect(createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText: `${promptExcerpt}old tail` }))
      .toEqual(createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText: `${promptExcerpt}new tail` }))
  })

  it('validates a persisted score map under one fence-first transaction and returns the current map', async () => {
    const order: string[] = [], tx = transaction()
    const fingerprint = createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText })
    mocks.sourceFence.mockImplementation(async () => { order.push('fence') })
    mocks.resumeFindFirst.mockImplementation(async () => { order.push('resume'); return resume() })
    mocks.jobFindFirst.mockImplementation(async () => { order.push('job'); return jobInputs() })

    const result = await validateAnalyzeSourceFingerprints(tx, {
      userId: 'user_1', resumeId: 'resume_1', resumeText, jobIds: [job.id], sourceFingerprintsByJob: { [job.id]: fingerprint },
    })

    expect(order).toEqual(['fence', 'resume', 'job'])
    expect(result).toEqual({ [job.id]: fingerprint })
    expect(mocks.sourceFence).toHaveBeenCalledWith(tx, ['user_1'])
    expect(mocks.jobFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: job.id, userId: 'user_1' } }))
  })

  it('rejects missing, malformed, incomplete, or stale persisted fingerprints before reusing scores', async () => {
    const fingerprint = createAnalyzeSourceFingerprint({ userId: 'user_1', jobId: job.id, job: jobInputs(), resumeId: 'resume_1', resumeText })
    expect(hasCompleteAnalyzeSourceFingerprints([job.id], undefined)).toBe(false)
    expect(hasCompleteAnalyzeSourceFingerprints([job.id], { [job.id]: { ...fingerprint, digest: 'bad' } })).toBe(false)
    expect(hasCompleteAnalyzeSourceFingerprints([job.id], { [job.id]: fingerprint, extra: fingerprint })).toBe(false)
    mocks.jobFindFirst.mockResolvedValue({ ...jobInputs(), description: 'Updated source text' })

    await expect(validateAnalyzeSourceFingerprints(transaction(), {
      userId: 'user_1', resumeId: 'resume_1', resumeText, jobIds: [job.id], sourceFingerprintsByJob: { [job.id]: fingerprint },
    })).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
  })

  it('keeps exact Analyze claim metadata server-only, bounded, canonical, and immutable', () => {
    const error = new AnalyzeSourceChangedError(), fenceAt = new Date('2026-11-16T10:20:30.123Z')
    expect(attachAnalyzeSourceChangedClaims(error, [{ jobId: job.id, analysisFenceAt: fenceAt }], 1)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(error)).toEqual([{ jobId: job.id, analysisFenceAt: fenceAt.toISOString() }])
    expect(JSON.stringify(error)).toBe('{}')
    expect(Object.keys(error)).not.toContain('analysisFenceAt')
    expect(attachAnalyzeSourceChangedClaims(error, [{ jobId: job.id, analysisFenceAt: fenceAt }, { jobId: job.id, analysisFenceAt: fenceAt }], 2)).toBe(false)
    expect(readAnalyzeSourceChangedClaims(error)).toEqual([{ jobId: job.id, analysisFenceAt: fenceAt.toISOString() }])
  })

  it('rejects malformed, duplicate, invalid-date, extra-field, and over-bound claim metadata', () => {
    const fenceAt = '2026-11-16T10:20:30.123Z'
    expect(readAnalyzeSourceChangedClaims(createAnalyzeSourceChangedErrorWithClaims([], 0))).toEqual([])
    expect(readAnalyzeSourceChangedClaims(createAnalyzeSourceChangedErrorWithClaims([
      { jobId: job.id, analysisFenceAt: fenceAt }, { jobId: job.id, analysisFenceAt: fenceAt },
    ]))).toBeNull()
    expect(readAnalyzeSourceChangedClaims(createAnalyzeSourceChangedErrorWithClaims([
      { jobId: job.id, analysisFenceAt: 'not-an-iso-date' },
    ]))).toBeNull()
    expect(readAnalyzeSourceChangedClaims(createAnalyzeSourceChangedErrorWithClaims([
      { jobId: job.id, analysisFenceAt: fenceAt, userId: 'user_1' } as never,
    ]))).toBeNull()
    const tooMany = Array.from({ length: MAX_ANALYZE_SOURCE_CHANGE_CLAIMS + 1 }, (_, index) => ({
      jobId: `job_${index}`, analysisFenceAt: fenceAt,
    }))
    expect(readAnalyzeSourceChangedClaims(createAnalyzeSourceChangedErrorWithClaims(tooMany, tooMany.length))).toBeNull()
  })

  it('keeps the model prompt excerpts bounded and parses fenced score JSON', () => {
    const longResume = `${'r'.repeat(2_000)}UNUSED_RESUME_SENTINEL`, longDescription = `${'d'.repeat(1_000)}UNUSED_DESCRIPTION_SENTINEL`
    const prompt = buildScorePrompt(longResume, { ...job, description: longDescription } as Job)
    expect(prompt).toContain(longResume.slice(0, 2_000))
    expect(prompt).not.toContain('UNUSED_RESUME_SENTINEL')
    expect(prompt).toContain(longDescription.slice(0, 1_000))
    expect(prompt).not.toContain('UNUSED_DESCRIPTION_SENTINEL')
    expect(parseScoreResult('```json\n{"score":73,"matchedKeywords":["TypeScript"]}\n```'))
      .toMatchObject({ score: 73, matchedKeywords: ['TypeScript'], missingKeywords: [], recommendation: '' })
  })

  it('preserves Analyze result acceptance checks', () => {
    expect(acceptAnalyze({ stage: 'analyze', ok: false, error: 'score failed', metrics: { durationMs: 0, count: 0 } }))
      .toEqual({ ok: false, reason: 'score failed' })
    expect(acceptAnalyze({ stage: 'analyze', ok: true, data: { scoredJobs: [{ job, score: 101, matchedKeywords: [], missingKeywords: [], recommendation: '' }], failed: 0 }, metrics: { durationMs: 1, count: 1 } }))
      .toEqual({ ok: false, reason: 'Job job_1 has invalid score: 101' })
  })
})
