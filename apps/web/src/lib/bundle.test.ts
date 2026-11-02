import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadApplicationPack, downloadJobBundle } from './bundle'

const mocks = vi.hoisted(() => ({ saveAs: vi.fn() }))
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }))

afterEach(() => { vi.restoreAllMocks(); mocks.saveAs.mockClear() })

describe('browser application-pack download', () => {
  it('downloads the ZIP from the audited endpoint instead of refetching unreviewed documents', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('PK-zip', {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': "attachment; filename*=UTF-8''Example_application-pack.zip" },
    }))
    expect(await downloadApplicationPack('job_1')).toEqual({ filename: 'Example_application-pack.zip' })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/jobs/job_1/application-pack', { method: 'POST' })
    expect(mocks.saveAs).toHaveBeenCalledWith(expect.any(Blob), 'Example_application-pack.zip')
  })

  it('keeps older bundle callers on the same audit gate and surfaces stale-audit errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Run the audit again.' }, { status: 409 }))
    await expect(downloadJobBundle('job_1')).rejects.toThrow('Run the audit again.')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/jobs/job_1/application-pack', { method: 'POST' })
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })

  it('does not download a login page or an empty response as a ZIP', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('', { headers: { 'Content-Type': 'application/zip' } }))
    await expect(downloadApplicationPack('job_1')).rejects.toThrow('did not return an application ZIP')
    await expect(downloadApplicationPack('job_1')).rejects.toThrow('ZIP is empty')
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })
})
