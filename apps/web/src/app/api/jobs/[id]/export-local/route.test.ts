import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const mocks = vi.hoisted(() => ({
  jobFindFirst: vi.fn(), activityFindFirst: vi.fn(), resumeFindFirst: vi.fn(), coverLetterFindFirst: vi.fn(),
  access: vi.fn(), mkdir: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), execFile: vi.fn(), spawn: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ access: mocks.access, mkdir: mocks.mkdir, readdir: mocks.readdir, writeFile: mocks.writeFile }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }))
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst }, activity: { findFirst: mocks.activityFindFirst },
  resume: { findFirst: mocks.resumeFindFirst }, coverLetter: { findFirst: mocks.coverLetterFindFirst },
} }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: vi.fn().mockResolvedValue({ userId: 'user_1' }), isErrorResponse: () => false, ok: (data: unknown, status = 200) => Response.json(data, { status }), err: (message: string, status = 400) => Response.json({ error: message }, { status }) }))

describe('local application-pack export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'Acme', role: 'Engineer', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' })
    mocks.activityFindFirst.mockResolvedValue({ text: '[Auditor] application-audit {"resumeId":"resume_1","coverLetterId":"letter_1","audit":{"verdict":"pass"}}' })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_1', templateId: 'clean', templateOptions: {}, content: { contact: { name: 'Ada' } } })
    mocks.coverLetterFindFirst.mockResolvedValue({ id: 'letter_1', content: 'Dear Acme' })
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ resumePdf: Buffer.from('pdf').toString('base64'), coverLetterPdf: Buffer.from('pdf').toString('base64') }))
        child.emit('close', 0)
      })
      return child
    })
    mocks.access.mockResolvedValue(undefined); mocks.readdir.mockResolvedValue(['tsx@4.22.3']); mocks.mkdir.mockResolvedValue(undefined); mocks.writeFile.mockResolvedValue(undefined)
    mocks.execFile.mockImplementation((_file: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, '', '')
      return undefined as never
    })
    process.env.APPLYMATE_LOCAL_EXPORT_ROOT = 'D:\\My Jobs resume'
  })

  it('writes the audited resume and matching cover letter into the job folder', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/jobs/job_1/export-local', { method: 'POST', body: '{}' }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringContaining('Acme - Engineer'), { recursive: true })
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
  })

  it('refuses local export when the final documents have not passed factual audit', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: '[Auditor] application-audit {"resumeId":"resume_1","coverLetterId":"letter_1","audit":{"verdict":"blocked"}}' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/jobs/job_1/export-local', { method: 'POST', body: '{}' }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response.status).toBe(409)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('opens an existing job folder without rendering the PDFs again', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/jobs/job_1/export-local', { method: 'POST', body: '{"openFolder":true,"openOnly":true}' }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.access).toHaveBeenCalledWith(expect.stringContaining('Acme - Engineer'))
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('keeps an open PDF and exports a timestamped replacement instead of failing', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
    mocks.writeFile.mockRejectedValueOnce(busy).mockResolvedValue(undefined)
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/jobs/job_1/export-local', { method: 'POST', body: '{}' }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.resumeFile).toMatch(/^Resume - \d{4}-\d{2}-\d{2}T/)
    expect(mocks.writeFile).toHaveBeenCalledTimes(3)
  })
})
