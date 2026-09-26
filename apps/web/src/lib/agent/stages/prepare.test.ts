import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  taskUpdateMany: vi.fn(),
  refreshExecutionAttempt: vi.fn(),
  resumeCreate: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  coverLetterUpdate: vi.fn(),
  coverLetterCreate: vi.fn(),
  jobUpdate: vi.fn(),
  modelChat: vi.fn(),
  buildPersona: vi.fn(),
  personaEvidenceContext: vi.fn(),
  retrievePersonaEvidence: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('../execution-control', () => ({
  refreshAgentExecutionAttempt: mocks.refreshExecutionAttempt,
  AgentExecutionCancelledError: class extends Error {
    constructor() {
      super('Agent execution was cancelled')
      this.name = 'AgentExecutionCancelledError'
    }
  },
}))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat, stripFences: (value: string) => value }))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))
vi.mock('@/lib/persona-evidence', () => ({
  personaEvidenceContext: mocks.personaEvidenceContext,
  retrievePersonaEvidence: mocks.retrievePersonaEvidence,
}))
vi.mock('../role-config', () => ({ roleAiConfig: vi.fn(() => ({ provider: 'minimax', model: 'test', apiKey: 'key' })) }))
vi.mock('../artifacts/provenance', () => ({ assertSupportedClaims: vi.fn(() => []) }))
vi.mock('../artifacts/repository', () => ({ buildDraftArtifactSummary: vi.fn(input => ({ ...input, hash: 'sha256:draft' })) }))
vi.mock('../artifacts/hash', () => ({ hashArtifactContent: vi.fn(() => 'sha256:base') }))
vi.mock('../artifacts/item', () => ({ artifactItemData: vi.fn(artifact => ({ id: artifact.id, kind: artifact.kind })) }))

import type { PipelineCtx, ScoredJob } from '../types'
import { preparationFloor, runPrepare } from './prepare'

const fence = '2026-09-26T10:00:00.001Z'

function scoredJob(score = 90): ScoredJob {
  return {
    job: { id: 'job_1', company: 'Acme', role: 'Engineer', description: 'TypeScript', location: 'Berlin' } as never,
    score,
    matchedKeywords: ['TypeScript'],
    missingKeywords: [],
    recommendation: 'Strong fit',
    analysisFenceAt: fence,
  }
}

function context(withExecutionAttempt = false, autoCoverLetter = false, signal?: AbortSignal): PipelineCtx {
  return {
    userId: 'user_1',
    sessionId: 'session_1',
    agentCfg: {
      minMatchScore: 70,
      autoCoverLetter,
      coverTone: 'professional',
      throttleMs: 0,
      targetRoles: [],
      targetLocations: [],
      excludeCompanies: [],
      priorityCompanies: [],
    } as never,
    roleConfigs: { writer: {} } as never,
    resumeText: 'Engineer',
    resumeContent: { summary: 'Engineer' } as never,
    defaultResume: {
      id: 'resume_base', name: 'Base CV', templateId: null, templateOptions: null,
      directionId: null, basicsDetached: false,
    },
    aiConfig: { provider: 'minimax', model: 'test', apiKey: 'key' } as never,
    autonomous: false,
    emit: vi.fn(),
    ...(withExecutionAttempt ? { executionAttempt: { id: 'execution_1', attemptCount: 2 } } : {}),
    ...(signal ? { signal } : {}),
  }
}

const tx = {
  applicationTask: { updateMany: mocks.taskUpdateMany },
  resume: { create: mocks.resumeCreate },
  coverLetter: {
    findFirst: mocks.coverLetterFindFirst,
    update: mocks.coverLetterUpdate,
    create: mocks.coverLetterCreate,
  },
  job: { update: mocks.jobUpdate },
}

describe('preparationFloor', () => {
  it('uses the configured candidate threshold instead of a hard-coded score', () => {
    expect(preparationFloor(85)).toBe(80)
    expect(preparationFloor(60)).toBe(55)
    expect(preparationFloor(3)).toBe(0)
  })
})

describe('runPrepare ownership fences', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.transaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(tx))
    mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.refreshExecutionAttempt.mockResolvedValue(true)
    mocks.resumeCreate.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored CV' })
    mocks.coverLetterFindFirst.mockResolvedValue(null)
    mocks.coverLetterCreate.mockResolvedValue({ id: 'cover_letter_1' })
    mocks.coverLetterUpdate.mockResolvedValue({ id: 'cover_letter_1' })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.modelChat.mockResolvedValue({ text: '{"summary":"Engineer"}' })
    mocks.buildPersona.mockResolvedValue('Confirmed facts')
    mocks.personaEvidenceContext.mockResolvedValue('')
    mocks.retrievePersonaEvidence.mockResolvedValue([])
  })

  it('does not call the writer or persist material when the Analyze version is stale', async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 })

    const result = await runPrepare([scoredJob()], context())

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'analyzing', checkpoint: 'match_analysis', updatedAt: new Date(fence),
      }),
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    }))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(result.data?.packages).toEqual([])
  })

  it('does not mark a below-threshold task skipped after its execution attempt is superseded', async () => {
    mocks.refreshExecutionAttempt.mockResolvedValue(false)

    await runPrepare([scoredJob(50)], context(true))

    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledOnce()
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })

  it('does not persist a tailored resume after the execution attempt is superseded', async () => {
    mocks.refreshExecutionAttempt.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const result = await runPrepare([scoredJob()], context(true))

    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
    expect(result.data?.packages).toEqual([])
  })

  it('does not persist a tailored resume after the ApplicationTask leaves Prepare', async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const result = await runPrepare([scoredJob()], context(true))

    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(result.data?.packages).toEqual([])
  })

  it('does not persist a cover letter after the ApplicationTask leaves Prepare', async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const result = await runPrepare([scoredJob()], context(true, true), { allowResumeTailoring: false })

    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.coverLetterFindFirst).not.toHaveBeenCalled()
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(result.data?.packages).toEqual([])
  })

  it('guards the Job coverLetter mirror and drops the package if ownership is lost', async () => {
    mocks.taskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    const result = await runPrepare([scoredJob()], context(true, true), { allowResumeTailoring: false })

    expect(mocks.coverLetterCreate).toHaveBeenCalledOnce()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(result.data?.packages).toEqual([])
  })

  it('does not persist material or Job fields when aborted during a pending writer call', async () => {
    const controller = new AbortController()
    let finishWriter!: (value: { text: string }) => void
    mocks.modelChat.mockImplementationOnce(() => new Promise(resolve => { finishWriter = resolve }))
    const ctx = context(true, true, controller.signal)
    const preparing = runPrepare([scoredJob()], ctx, { allowResumeTailoring: false })
    await vi.waitFor(() => expect(mocks.modelChat).toHaveBeenCalledOnce())

    controller.abort()
    finishWriter({ text: 'A generated cover letter' })
    const result = await preparing

    expect(result.data?.packages).toEqual([])
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.coverLetterFindFirst).not.toHaveBeenCalled()
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalledWith('artifact_created', expect.anything())
  })
})
