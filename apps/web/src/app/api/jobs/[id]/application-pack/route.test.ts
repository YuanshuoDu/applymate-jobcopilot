import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { auditActivityText as unsignedAuditActivityText, parseStoredApplicationAudit } from '@/lib/application-audit'
import { signedAuditActivityText, verifyApplicationAuditReceipt } from '@/lib/application-audit-receipt'
import { AUDIT_ACTIVITY_PREFIX } from '@/lib/application-audit'
import { auditJobBasisHash, auditMaterialBasisHash } from '@/lib/application-audit-operation'
import type { ApplicationAudit } from '@/lib/types'
import { UnsupportedPdfTextError } from '@/lib/pdf-text-support'
import { ApplicationPdfUnsupportedCharactersError } from '@/lib/application-pdf-errors'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), job: vi.fn(), resume: vi.fn(), coverLetter: vi.fn(), activity: vi.fn(), render: vi.fn(), operation: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.job }, resume: { findFirst: mocks.resume },
  coverLetter: { findFirst: mocks.coverLetter }, activity: { findFirst: mocks.activity },
} }))
vi.mock('@/lib/application-audit-transaction', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/application-audit-transaction')>(),
  withApplicationAuditLock: async (_scope: unknown, run: (tx: unknown) => unknown) => run({
    job: { findFirst: mocks.job }, resume: { findFirst: mocks.resume }, coverLetter: { findFirst: mocks.coverLetter },
  }),
  lockApplicationAuditMaterials: async () => true,
}))
vi.mock('@/lib/application-audit-operation', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/application-audit-operation')>(), readAuditOperation: mocks.operation,
}))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.auth, isErrorResponse: (value: unknown) => value instanceof Response,
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/application-pack', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/application-pack')>(), renderApplicationPack: mocks.render,
}))
import { GET, POST } from './route'

vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode('unit-test-download-key') }))
const auditActivityText = (...args: Parameters<typeof unsignedAuditActivityText>) => signedAuditActivityText({ userId: 'user_1', jobId: 'job_1' }, ...args)

const revision = '2026-11-02T09:00:00.000Z'
const job = { id: 'job_1', company: 'Acme', role: 'Engineer', description: 'Synthetic role', url: 'https://example.test/jobs/1', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' }
const resume = { id: 'resume_1', name: 'Synthetic resume', templateId: null, templateOptions: null, updatedAt: new Date(revision), content: { contact: { name: 'Sample Candidate' } } }
const coverLetter = { id: 'letter_1', tone: 'professional', templateId: null, templateOptions: null, updatedAt: new Date(revision), content: 'Dear Acme' }
let auditedResume = resume
let auditedLetter = coverLetter
const audit: ApplicationAudit = {
  verdict: 'pass', matchScore: 90, summary: 'Supported.', source: 'parent_resume', auditedAt: revision,
  findings: ['resume', 'cover_letter'].map(area => ({ area: area as 'resume' | 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Source resume', action: 'None' })),
}

function invoke() {
  return POST(new Request('https://applymate.site/api/jobs/job_1/application-pack', { method: 'POST' }) as never, { params: Promise.resolve({ id: 'job_1' }) })
}
function invokePrint() {
  return GET(new Request('https://applymate.site/api/jobs/job_1/application-pack') as never, { params: Promise.resolve({ id: 'job_1' }) })
}

describe('authenticated application ZIP download', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    auditedResume = resume
    auditedLetter = coverLetter
    mocks.auth.mockResolvedValue({ userId: 'user_1' })
    mocks.job.mockResolvedValue(job)
    mocks.resume.mockResolvedValue(resume)
    mocks.coverLetter.mockResolvedValue(coverLetter)
    mocks.activity.mockResolvedValue({ text: auditActivityText('resume_1', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    mocks.operation.mockImplementation(async (_tx: unknown, scope: { userId: string; jobId: string }) => {
      const activity = await mocks.activity({ where: { ...scope, text: { startsWith: AUDIT_ACTIVITY_PREFIX } }, orderBy: { createdAt: 'desc' }, select: { text: true } })
      const stored = parseStoredApplicationAudit(activity?.text ?? '')
      return verifyApplicationAuditReceipt(scope, stored) ? { kind: 'completed', audit: stored, jobBasisHash: auditJobBasisHash(job), materialBasisHash: auditMaterialBasisHash(auditedResume, stored.coverLetterId ? auditedLetter : null) } : { kind: 'invalid', source: 'legacy' }
    })
    mocks.render.mockResolvedValue({ bytes: new Uint8Array([80, 75, 3, 4]), filename: 'Acme_Engineer_application-pack.zip' })
  })

  it.each(['resume', 'coverLetter'] as const)('blocks ZIP and print for oversized %s even with a signed passing audit', async area => {
    if (area === 'resume') {
      auditedResume = { ...resume, content: { contact: { name: 'x'.repeat(12_000) } } }
      mocks.resume.mockResolvedValue(auditedResume)
    } else {
      auditedLetter = { ...coverLetter, content: 'x'.repeat(8_001) }
      mocks.coverLetter.mockResolvedValue(auditedLetter)
    }
    expect((await invoke()).status).toBe(409)
    expect((await invokePrint()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('blocks ZIP and print for an earlier receipt that could have used truncated evidence', async () => {
    const oldPayload = ['applymate.audit-material-basis', 1,
      [resume.id, resume.name, resume.content, resume.templateId, resume.templateOptions],
      [coverLetter.id, coverLetter.content, coverLetter.tone, coverLetter.templateId, coverLetter.templateOptions]]
    const oldHash = createHash('sha256').update(JSON.stringify(oldPayload)).digest('hex')
    const activity = parseStoredApplicationAudit(auditActivityText('resume_1', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }))
    mocks.operation.mockResolvedValue({ kind: 'completed', audit: activity, jobBasisHash: auditJobBasisHash(job), materialBasisHash: oldHash })
    expect((await invoke()).status).toBe(409)
    expect((await invokePrint()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('passes the audited fallback header name to ZIP and displays it in print', async () => {
    auditedResume = { ...resume, name: 'Fallback Candidate', content: { contact: { name: '' } } }
    mocks.resume.mockResolvedValue(auditedResume)
    expect((await invoke()).status).toBe(200)
    expect(mocks.render).toHaveBeenCalledWith(job, auditedResume, coverLetter, expect.anything())
    const print = await invokePrint()
    expect(print.status).toBe(200)
    expect(await print.text()).toContain('<h1>Fallback Candidate</h1>')
  })

  it.each(['pending', 'failed', 'invalid'] as const)('blocks ZIP and print while audit state is %s', async kind => {
    mocks.operation.mockResolvedValue({ kind })
    expect((await invoke()).status).toBe(409)
    expect((await invokePrint()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('requires a new review for a legacy audit without a job basis', async () => {
    mocks.operation.mockResolvedValue({ kind: 'legacy', audit: {} })
    expect((await invoke()).status).toBe(409)
    expect((await invokePrint()).status).toBe(409)
  })

  it('returns a private ZIP attachment for the exact audited, owner-scoped documents', async () => {
    const response = await invoke()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Acme_Engineer_application-pack.zip")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]))
    expect(mocks.job).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(mocks.resume).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
    expect(mocks.coverLetter).toHaveBeenCalledWith({ where: { id: 'letter_1', jobId: 'job_1', userId: 'user_1' } })
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1', jobId: 'job_1' }), orderBy: { createdAt: 'desc' } }))
    expect(mocks.render).toHaveBeenCalledWith(job, resume, coverLetter, expect.objectContaining({ resumeId: 'resume_1', coverLetterId: 'letter_1' }))
  })

  it.each([401, 403])('preserves authentication denial %s before reading documents', async status => {
    mocks.auth.mockResolvedValue(Response.json({ error: 'Denied' }, { status }))
    expect((await invoke()).status).toBe(status)
    expect(mocks.job).not.toHaveBeenCalled()
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('does not disclose another user’s job', async () => {
    mocks.job.mockResolvedValue(null)
    expect((await invoke()).status).toBe(404)
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('requires a selected final resume', async () => {
    mocks.job.mockResolvedValue({ ...job, finalResumeId: null })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it.each(['resume', 'coverLetter'] as const)('fails if the selected %s is missing or belongs to another account', async key => {
    mocks[key].mockResolvedValue(null)
    expect((await invoke()).status).toBe(404)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'needs_review'] as const)('does not fall back to an earlier pass when the latest audit is %s', async verdict => {
    mocks.activity.mockResolvedValue({ text: auditActivityText('resume_1', 'letter_1', { ...audit, verdict }, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it.each(['resume', 'coverLetter'] as const)('rejects an edit to the audited %s even when its ID is unchanged', async key => {
    const document = key === 'resume' ? resume : coverLetter
    mocks[key].mockResolvedValue({ ...document, updatedAt: new Date('2026-11-02T10:00:00.000Z') })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it.each(['resume', 'coverLetter'] as const)('rejects changed %s content even if its timestamp is unchanged', async key => {
    if (key === 'resume') mocks.resume.mockResolvedValue({ ...resume, content: { contact: { name: 'Different candidate' } } })
    else mocks.coverLetter.mockResolvedValue({ ...coverLetter, content: 'Different cover letter' })
    expect((await invoke()).status).toBe(409)
    expect((await invokePrint()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('rejects an audit for different final document IDs', async () => {
    mocks.activity.mockResolvedValue({ text: auditActivityText('older_resume', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('requires a new audit when a legacy record has no document revisions', async () => {
    mocks.activity.mockResolvedValue({ text: unsignedAuditActivityText('resume_1', 'letter_1', audit) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('rejects a historical forged pass even when its document revisions match', async () => {
    mocks.activity.mockResolvedValue({ text: unsignedAuditActivityText('resume_1', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it.each(['userId', 'jobId'] as const)('rejects a valid receipt from another %s', async field => {
    const scope = { userId: 'user_1', jobId: 'job_1', [field]: 'foreign-scope' }
    mocks.activity.mockResolvedValue({ text: signedAuditActivityText(scope, 'resume_1', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('rejects a signed result whose verdict was altered afterwards', async () => {
    const stored = parseStoredApplicationAudit(auditActivityText('resume_1', 'letter_1', { ...audit, verdict: 'blocked' }, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }))!
    stored.audit.verdict = 'pass'
    mocks.activity.mockResolvedValue({ text: unsignedAuditActivityText(stored.resumeId, stored.coverLetterId, stored.audit, stored) })
    expect((await invoke()).status).toBe(409)
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('supports an explicitly audited resume-only selection', async () => {
    mocks.job.mockResolvedValue({ ...job, finalCoverLetterId: null })
    mocks.activity.mockResolvedValue({ text: auditActivityText('resume_1', null, audit, { resumeUpdatedAt: revision }) })
    expect((await invoke()).status).toBe(200)
    expect(mocks.coverLetter).not.toHaveBeenCalled()
    expect(mocks.render).toHaveBeenCalledWith(expect.anything(), resume, null, expect.objectContaining({ coverLetterId: null }))
  })

  it('returns a retryable error without a partial ZIP if rendering fails', async () => {
    mocks.render.mockRejectedValue(new Error('Renderer unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await invoke()
    expect(response.status).toBe(500)
    expect(response.headers.get('Content-Type')).not.toBe('application/zip')
    expect(await response.json()).toEqual({ error: 'Could not generate the application PDFs. Please try again.' })
    log.mockRestore()
  })

  it.each([
    ['legacy renderer', new UnsupportedPdfTextError()],
    ['application renderer', new ApplicationPdfUnsupportedCharactersError()],
  ])('fails safely instead of exporting corrupted glyphs for %s', async (_renderer, error) => {
    error.message = 'internal details must not appear'
    mocks.render.mockRejectedValue(error)
    const response = await invoke()
    expect(response.status).toBe(422)
    expect(response.headers.get('Content-Type')).not.toBe('application/zip')
    const body = await response.json()
    expect(body.error).toContain('Print view / Save as PDF')
    expect(body.error).not.toContain('internal details')
  })

  it('serves the same audited snapshot in a private script-free Unicode print view', async () => {
    auditedResume = { ...resume, content: { contact: { name: '张伟' } } }
    auditedLetter = { ...coverLetter, content: 'Олена — <script>malicious()</script>' }
    mocks.resume.mockResolvedValue(auditedResume)
    mocks.coverLetter.mockResolvedValue(auditedLetter)
    const response = await invokePrint()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    const html = await response.text()
    expect(html).toContain('张伟')
    expect(html).toContain('Олена — &lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('does not provide a print bypass for unauthenticated, stale, or forged records', async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await invokePrint()).status).toBe(401)
    mocks.activity.mockResolvedValueOnce({ text: unsignedAuditActivityText('resume_1', 'letter_1', audit, { resumeUpdatedAt: revision, coverLetterUpdatedAt: revision }) })
    expect((await invokePrint()).status).toBe(409)
    mocks.resume.mockResolvedValue({ ...resume, updatedAt: new Date('2026-11-02T10:00:00.000Z') })
    expect((await invokePrint()).status).toBe(409)
    mocks.job.mockResolvedValue(null)
    expect((await invokePrint()).status).toBe(404)
  })
})
