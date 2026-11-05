import { afterEach, describe, expect, it, vi } from 'vitest'
import { BundleUnsupportedPdfError, downloadApplicationPack, downloadAuditedApplicationBundle, downloadJobBundle } from './bundle'

const mocks = vi.hoisted(() => ({ saveAs: vi.fn(), read: vi.fn(), same: vi.fn() }))
vi.mock('./application-export-snapshot', () => ({ readApplicationExportSnapshot: mocks.read, sameApplicationExportSnapshot: mocks.same }))
vi.mock('file-saver', () => ({ default: mocks.saveAs }))

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
    await expect(downloadJobBundle('job_1')).rejects.toThrow('Check the selected materials and audit')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/jobs/job_1/application-pack', { method: 'POST' })
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })

  it('offers print view for a 422 without displaying server-provided text or saving a ZIP', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'private server detail' }, { status: 422 }))
    const result = await downloadApplicationPack('job_1').catch(error => error)
    expect(result).toBeInstanceOf(BundleUnsupportedPdfError)
    expect(result.message).toContain('Print view / Save as PDF')
    expect(result.message).not.toContain('private server detail')
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })

  it('does not expose arbitrary server text from other failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'private server detail' }, { status: 500 }))
    const result = await downloadApplicationPack('job_1').catch(error => error)
    expect(result).not.toBeInstanceOf(BundleUnsupportedPdfError)
    expect(result.message).toBe('Could not download the application pack')
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


describe('audited account and material stability', () => {
  it('does not save the response if the account changes while downloading', async () => {
    let current = true
    mocks.read.mockResolvedValue({ id: 'first' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { current = false; return new Response('PK', { headers: { 'Content-Type': 'application/zip' } }) })
    await expect(downloadAuditedApplicationBundle('job', 'user', () => current)).rejects.toThrow(/session/)
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })
  it('does not save if audited materials change while the server renders', async () => {
    mocks.read.mockResolvedValueOnce({ id: 'first' }).mockResolvedValueOnce({ id: 'second' })
    mocks.same.mockReturnValue(false)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('PK', { headers: { 'Content-Type': 'application/zip' } }))
    await expect(downloadAuditedApplicationBundle('job', 'user', () => true)).rejects.toThrow(/changed/)
    expect(mocks.saveAs).not.toHaveBeenCalled()
  })
})
