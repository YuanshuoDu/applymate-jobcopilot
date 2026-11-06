import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditActivityText as unsignedAuditActivityText } from '@/lib/application-audit'
import { signedAuditActivityText, verifyApplicationAuditReceipt } from '@/lib/application-audit-receipt'
import { completeAuditOperation, readAuditOperation, registerAuditOperation } from '@/lib/application-audit-operation'
import type { ApplicationAudit } from '@/lib/types'

vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode('unit-test-audit-repair-key') }))
const scope = { userId: 'user_1', jobId: 'job_1' }
const auditActivityText = (...args: Parameters<typeof unsignedAuditActivityText>) => signedAuditActivityText(scope, ...args)

const mocks = {
  jobFindFirst: vi.fn(), resumeFindFirst: vi.fn(), resumeUpdate: vi.fn(),
  resumeVersionCreate: vi.fn(), coverLetterFindFirst: vi.fn(), coverLetterUpdate: vi.fn(),
  activityFindFirst: vi.fn(), activityFindUnique: vi.fn(), activityCreate: vi.fn(), activityUpsert: vi.fn(), activityUpdate: vi.fn(), prepareAiRoute: vi.fn(),
  withLock: vi.fn(), lockMaterials: vi.fn(),
  modelChat: vi.fn(), buildPersona: vi.fn(),
}

vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst, update: mocks.resumeUpdate },
  resumeVersion: { create: mocks.resumeVersionCreate, findFirst: vi.fn() },
  coverLetter: { findFirst: mocks.coverLetterFindFirst, update: mocks.coverLetterUpdate },
  activity: { findFirst: mocks.activityFindFirst, findUnique: mocks.activityFindUnique, create: mocks.activityCreate, upsert: mocks.activityUpsert, update: mocks.activityUpdate },
} }))
vi.mock('@/lib/application-audit-transaction', () => ({ withApplicationAuditLock: mocks.withLock, lockApplicationAuditMaterials: mocks.lockMaterials, AuditMaterialBusyError: class AuditMaterialBusyError extends Error {} }))
vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  requireAuth: vi.fn().mockResolvedValue({ userId: 'user_1' }),
  isErrorResponse: () => false,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: (raw: string) => JSON.parse(raw),
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))

const resumeContent = {
  contact: { name: 'Ada', email: 'ada@example.com', location: 'Dublin' },
  summary: 'Engineer', experience: [{ company: 'Acme', role: 'Engineer', period: '2021 – Present', bullets: ['Built systems.'] }],
  education: [], skills: ['TypeScript'],
}
const resumeRow = { id: 'resume_final', userId: 'user_1', name: 'Final', parentResumeId: 'resume_base', updatedAt: new Date('2026-09-22T10:01:00.000Z'), content: resumeContent, templateId: null, templateOptions: null }
const letterRow = { id: 'cover_1', content: 'Old letter', tone: 'professional', templateId: null, templateOptions: null, updatedAt: new Date('2026-09-22T10:01:30.000Z') }

function request(body: unknown) {
  return new Request('http://localhost/api/jobs/job_1/audit-application/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

function audit(overrides: Partial<ApplicationAudit> = {}): ApplicationAudit {
  return {
    verdict: 'needs_review', summary: 'Review one claim.', matchScore: 70,
    findings: [{
      area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary',
      title: 'Unsupported summary', evidence: 'The source does not confirm this wording.', action: 'Use supported wording.',
      proposedValue: 'Supported summary.',
    }],
    source: 'parent_resume', auditedAt: '2026-09-22T10:00:00.000Z', ...overrides,
  }
}

async function seedCurrentAudit(value: ApplicationAudit, coverLetterId: string | null = null, versions = { resumeUpdatedAt: '2026-09-22T10:01:00.000Z', coverLetterUpdatedAt: undefined as string | undefined }) {
  await mocks.withLock(scope, async (tx: Parameters<typeof registerAuditOperation>[0]) => {
    const op = await registerAuditOperation(tx, scope)
    expect(await completeAuditOperation(tx, scope, op, { resumeId: 'resume_final', coverLetterId, audit: value, jobBasis: { role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' }, materialBasis: { resume: resumeRow, coverLetter: coverLetterId ? letterRow : null }, versions })).toBe(true)
  })
  for (const mock of [mocks.withLock, mocks.activityCreate, mocks.activityUpsert, mocks.activityUpdate, mocks.activityFindUnique]) mock.mockClear()
}

describe('POST /api/jobs/[id]/audit-application/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.values(mocks).forEach(mock => mock.mockReset())
    let control: { userId: string; jobId: string; text: string } | null = null
    const tx = {
      job: { findFirst: mocks.jobFindFirst },
      resume: { findFirst: mocks.resumeFindFirst, update: mocks.resumeUpdate },
      resumeVersion: { create: mocks.resumeVersionCreate },
      coverLetter: { findFirst: mocks.coverLetterFindFirst, update: mocks.coverLetterUpdate },
      activity: { findFirst: mocks.activityFindFirst, findUnique: mocks.activityFindUnique, create: mocks.activityCreate, upsert: mocks.activityUpsert, update: mocks.activityUpdate },
    }
    mocks.withLock.mockImplementation(async (_scope, callback) => callback(tx))
    mocks.lockMaterials.mockResolvedValue(true)
    mocks.activityFindUnique.mockImplementation(async () => control)
    mocks.activityUpsert.mockImplementation(async ({ create, update }) => { control = control ? { ...control, ...update } : { userId: create.userId, jobId: create.jobId, text: create.text }; return control })
    mocks.activityUpdate.mockImplementation(async ({ data }) => { if (!control) throw new Error('Missing control'); control = { ...control, ...data }; return control })
    mocks.jobFindFirst.mockResolvedValue({ role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' })
    mocks.resumeFindFirst.mockResolvedValue(resumeRow)
    mocks.resumeUpdate.mockResolvedValue({ ...resumeRow, updatedAt: new Date('2026-09-22T10:02:00.000Z'), content: { ...resumeContent, summary: 'Supported summary.' } })
    mocks.resumeVersionCreate.mockResolvedValue({ id: 'version_1' })
    mocks.coverLetterFindFirst.mockResolvedValue(null)
    mocks.coverLetterUpdate.mockResolvedValue(null)
    mocks.activityCreate.mockResolvedValue({ id: 'activity_2' })
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M3', thinking: 'disabled' } })
    mocks.buildPersona.mockResolvedValue('CONFIRMED PERSONA')
  })

  it('applies a generated resume section, snapshots the old version, and marks the finding applied', async () => {
    const storedAudit = audit()
    await seedCurrentAudit(storedAudit)
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.audit.findings[0]).toMatchObject({ applied: true, target: 'summary', proposedValue: 'Supported summary.' })
    expect(mocks.resumeVersionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resumeId: 'resume_final', content: resumeContent }) }))
    expect(mocks.resumeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { content: { ...resumeContent, summary: 'Supported summary.' } } }))
    const stored = await readAuditOperation({ activity: { findFirst: mocks.activityFindFirst, findUnique: mocks.activityFindUnique } } as never, scope)
    expect(stored.kind).toBe('completed')
    if (stored.kind !== 'completed') throw new Error('Expected completed correction')
    expect(stored.audit.audit.findings[0].applied).toBe(true)
    expect(verifyApplicationAuditReceipt(scope, stored.audit)).toBe(true)
  })

  it('applies a cover-letter correction without changing the resume', async () => {
    const storedAudit = audit({ findings: [{
      area: 'cover_letter', severity: 'warning', resolution: 'evidence_needed', target: 'cover_letter',
      title: 'Unsupported letter claim', evidence: 'The source does not confirm this claim.', action: 'Remove it.',
      proposedValue: 'Dear Acme, I bring supported delivery experience.',
    }] })
    await seedCurrentAudit(storedAudit, 'cover_1', {
      resumeUpdatedAt: '2026-09-22T10:01:00.000Z', coverLetterUpdatedAt: '2026-09-22T10:01:30.000Z',
    })
    mocks.coverLetterFindFirst.mockResolvedValue(letterRow)
    mocks.coverLetterUpdate.mockResolvedValue({ ...letterRow, content: 'Dear Acme, I bring supported delivery experience.', updatedAt: new Date('2026-09-22T10:03:00.000Z') })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.audit.findings[0].applied).toBe(true)
    expect(mocks.coverLetterUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { content: 'Dear Acme, I bring supported delivery experience.' } }))
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it('rejects an audit finding when the audited resume has changed', async () => {
    const storedAudit = audit()
    await seedCurrentAudit(storedAudit, null, { resumeUpdatedAt: '2026-09-22T09:00:00.000Z', coverLetterUpdatedAt: undefined })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!

    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
  })

  it('rejects unsigned historical corrections before modifying a document', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: unsignedAuditActivityText('resume_final', null, audit(), { resumeUpdatedAt: '2026-09-22T10:01:00.000Z' }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.coverLetterUpdate).not.toHaveBeenCalled()
  })

  it('rejects a previously signed legacy audit without a job basis', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: auditActivityText('resume_final', null, audit(), { resumeUpdatedAt: '2026-09-22T10:01:00.000Z' }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
  })

  it.each(['role', 'company', 'description'] as const)('rejects correction when the job %s changed after audit', async field => {
    await seedCurrentAudit(audit())
    mocks.jobFindFirst.mockResolvedValue({ role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.', [field]: 'Changed' })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it.each(['role', 'company', 'description'] as const)('rejects correction when job %s changes between the first read and locked write', async field => {
    await seedCurrentAudit(audit())
    const original = { role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' }
    mocks.jobFindFirst.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, [field]: 'Changed during correction' })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.lockMaterials).toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('rejects a resume content change even when the timestamp remains the same', async () => {
    await seedCurrentAudit(audit())
    mocks.resumeFindFirst.mockResolvedValue({ ...resumeRow, content: { ...resumeContent, summary: 'Changed at the same timestamp' } })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
  })

  it('rejects a same-timestamp content change between the first read and the locked write', async () => {
    await seedCurrentAudit(audit())
    mocks.resumeFindFirst.mockResolvedValueOnce(resumeRow).mockResolvedValueOnce({ ...resumeRow, content: { ...resumeContent, summary: 'Concurrent edit' } })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.lockMaterials).toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
  })

  it('returns a conflict when material locks are busy', async () => {
    await seedCurrentAudit(audit())
    const { AuditMaterialBusyError } = await import('@/lib/application-audit-transaction')
    mocks.lockMaterials.mockRejectedValueOnce(new AuditMaterialBusyError())
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('being changed') })
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it('generates a safe replacement when the audit did not provide one', async () => {
    const storedAudit = audit({ findings: [{
      area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary',
      title: 'Unsupported summary', evidence: 'The source does not confirm this wording.', action: 'Use supported wording.',
    }] })
    await seedCurrentAudit(storedAudit)
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ proposedValue: 'Generated supported summary.' }) })
    mocks.resumeUpdate.mockResolvedValue({ ...resumeRow, updatedAt: new Date('2026-09-22T10:02:00.000Z'), content: { ...resumeContent, summary: 'Generated supported summary.' } })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.appliedContent).toBe('Generated supported summary.')
    expect(mocks.modelChat).toHaveBeenCalled()
    expect(mocks.buildPersona).toHaveBeenCalledWith('user_1', 'tailor')
  })

  it('does not write a correction or resume history when a new audit supersedes it', async () => {
    await seedCurrentAudit(audit())
    const normalLock = mocks.withLock.getMockImplementation()!
    mocks.withLock.mockImplementationOnce(normalLock).mockImplementationOnce(async (operationScope, callback) => normalLock(operationScope, async (tx: Parameters<typeof registerAuditOperation>[0]) => {
      await registerAuditOperation(tx, scope)
      return callback(tx)
    }))
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.coverLetterUpdate).not.toHaveBeenCalled()
    // The competing new audit archives the prior completed record exactly once;
    // the stale correction itself writes neither materials nor resume history.
    expect(mocks.activityCreate).toHaveBeenCalledTimes(1)
  })

  it('does not report success when the correction transaction fails', async () => {
    await seedCurrentAudit(audit())
    mocks.resumeVersionCreate.mockRejectedValueOnce(new Error('transaction failure'))
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(503)
    expect(await response.json()).not.toHaveProperty('audit')
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.activityUpdate).not.toHaveBeenCalled()
  })

  it('returns 503 without changing materials or history if the initial job lock fails', async () => {
    await seedCurrentAudit(audit())
    mocks.withLock.mockRejectedValueOnce(new Error('Initial transaction unavailable'))
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('review status could not be read') })
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.coverLetterUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.activityUpsert).not.toHaveBeenCalled()
    expect(mocks.activityUpdate).not.toHaveBeenCalled()
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })
})
