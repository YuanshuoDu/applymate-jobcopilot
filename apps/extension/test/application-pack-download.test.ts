import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionSettings, SavedJob } from '../src/lib/types'

const mocks = vi.hoisted(() => ({ save: vi.fn(), print: vi.fn(), settings: vi.fn() }))
vi.mock('../src/lib/download-response', () => ({ saveApplicationPackResponse: mocks.save, openApplicationPackPrintResponse: mocks.print }))
vi.mock('../src/lib/storage', () => ({ getCurrentResumeId: vi.fn(), getSettings: mocks.settings }))
import { downloadApplicationPack, openApplicationPackPrint, prepareApplicationPack } from '../src/lib/api'

const settings: ExtensionSettings = { apiBaseUrl: 'https://applymate.site', apiToken: 'test-token', userEmail: 'sample@example.test', userName: 'Sample', autoSave: false }
const selectedJob = { id: 'job_1', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' } as SavedJob

beforeEach(() => { mocks.save.mockResolvedValue({ filename: 'application-pack.zip' }) })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('application-pack API', () => {
  it('fetches a binary ZIP with the extension account token', async () => {
    const response = new Response('zip', { headers: { 'Content-Type': 'application/zip' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    expect(await downloadApplicationPack(settings, 'job_1')).toEqual({ filename: 'application-pack.zip' })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://applymate.site/api/jobs/job_1/application-pack', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
    expect(mocks.save).toHaveBeenCalledWith(response)
  })

  it('shows the stale-audit error without downloading or retrying it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Run the audit again.' }, { status: 409 }))
    await expect(downloadApplicationPack(settings, 'job_1')).rejects.toThrow('Run the audit again.')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('rechecks selected documents instead of inventing a passing audit or regenerating them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ verdict: 'pass', summary: 'Rechecked.' }))
    const onStage = vi.fn()
    const result = await prepareApplicationPack(settings, selectedJob, onStage)
    expect(result.audit.summary).toBe('Rechecked.')
    expect(onStage).toHaveBeenCalledExactlyOnceWith('audit')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://applymate.site/api/jobs/job_1/audit-application', expect.objectContaining({ method: 'POST', body: JSON.stringify({ resumeId: 'resume_1', coverLetterId: 'letter_1' }) }))
  })

  it('keeps a failed recheck visible instead of treating final IDs as audit approval', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ verdict: 'needs_review', summary: 'Review the unsupported claim.' }))
    await expect(prepareApplicationPack(settings, selectedJob)).rejects.toThrow('Review the unsupported claim.')
  })

  it('retrieves the print fallback with the same account token and audit gate', async () => {
    const response = new Response('<html>Print view</html>', { headers: { 'Content-Type': 'text/html' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await openApplicationPackPrint(settings, 'job_1')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://applymate.site/api/jobs/job_1/application-pack', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
    expect(mocks.print).toHaveBeenCalledWith(response)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
