import { afterEach, describe, expect, it, vi } from 'vitest'
import { readApplicationExportSnapshot, sameApplicationExportSnapshot } from './application-export-snapshot'

const at = '2026-10-30T10:00:00.000Z'
function fixture() {
  return {
    job: { id: 'job', userId: 'user', company: 'Example', role: 'Engineer', finalResumeId: 'resume', finalCoverLetterId: null as string | null },
    resume: { id: 'resume', userId: 'user', updatedAt: at, content: { summary: 'Example' } },
    audit: { resumeId: 'resume', coverLetterId: null as string | null, resumeUpdatedAt: at, audit: { verdict: 'pass', auditedAt: at } },
    letters: [] as Array<Record<string, unknown>>,
  }
}
function install(data: ReturnType<typeof fixture>, badPath?: string) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === badPath) return new Response('{}', { status: 500 })
    const value = path.endsWith('/audit-application') ? data.audit : path.endsWith('/cover-letters') ? data.letters : path.startsWith('/api/resume/') ? data.resume : data.job
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
afterEach(() => vi.unstubAllGlobals())

describe('audited browser export snapshot', () => {
  it('accepts an owned audited resume-only set and compares its captured inputs', async () => {
    const data = fixture(); install(data)
    const first = await readApplicationExportSnapshot('job', 'user')
    expect(first.coverLetter).toBeNull()
    expect(sameApplicationExportSnapshot(first, await readApplicationExportSnapshot('job', 'user'))).toBe(true)
    data.resume.content.summary = 'Changed without a revision update'
    expect(sameApplicationExportSnapshot(first, await readApplicationExportSnapshot('job', 'user'))).toBe(false)
  })
  it('rejects missing, failed or misbound selected cover letters', async () => {
    const data = fixture(); data.job.finalCoverLetterId = 'letter'; data.audit.coverLetterId = 'letter'
    install(data); await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.letters.push({ id: 'letter', userId: 'other', jobId: 'job', updatedAt: at, content: 'Hello' })
    await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.letters[0].userId = 'user'; data.letters[0].jobId = 'other'
    await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.letters[0].jobId = 'job'; install(data, '/api/jobs/job/cover-letters')
    await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
  })
  it('exports exactly the selected, owned cover letter at its audited revision', async () => {
    const data = fixture(); data.job.finalCoverLetterId = 'letter'; data.audit.coverLetterId = 'letter'
    Object.assign(data.audit, { coverLetterUpdatedAt: at })
    data.letters.push({ id: 'letter', userId: 'user', jobId: 'job', updatedAt: at, content: 'Selected' })
    data.letters.push({ id: 'other', userId: 'user', jobId: 'job', updatedAt: at, content: 'Not selected' })
    install(data)
    await expect(readApplicationExportSnapshot('job', 'user')).resolves.toMatchObject({ coverLetter: { id: 'letter', content: 'Selected' } })
    data.letters[0].updatedAt = '2026-10-30T11:00:00.000Z'
    await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
  })
  it('requires owner, passing audit, matching IDs and current revisions', async () => {
    const data = fixture(); install(data)
    data.job.userId = 'other'; await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.job.userId = 'user'; data.audit.audit.verdict = 'needs_review'; await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.audit.audit.verdict = 'pass'; data.audit.resumeId = 'wrong'; await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
    data.audit.resumeId = 'resume'; data.resume.updatedAt = '2026-10-30T11:00:00.000Z'; await expect(readApplicationExportSnapshot('job', 'user')).rejects.toThrow()
  })
  it('retains the existing legacy audit timestamp fallback', async () => {
    const data = fixture(); delete (data.audit as { resumeUpdatedAt?: string }).resumeUpdatedAt; install(data)
    await expect(readApplicationExportSnapshot('job', 'user')).resolves.toMatchObject({ resume: { id: 'resume' } })
  })
})
