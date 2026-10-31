import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), same: vi.fn(), save: vi.fn(), toBlob: vi.fn(), render: vi.fn(), folder: vi.fn() }))
vi.mock('./application-export-snapshot', () => ({ readApplicationExportSnapshot: mocks.read, sameApplicationExportSnapshot: mocks.same }))
vi.mock('@react-pdf/renderer', () => ({ pdf: () => ({ toBlob: mocks.toBlob }) }))
vi.mock('@/lib/resume-pdf', () => ({ renderResumeDoc: mocks.render }))
// The package's CommonJS export is a function. Next's production webpack
// namespace exposes it as default rather than a named saveAs export.
vi.mock('file-saver', () => ({ default: mocks.save }))
vi.mock('jszip', () => ({ default: class { folder(name: string) { mocks.folder(name); return this } file() { return this } async generateAsync() { return new Blob(['zip']) } } }))

import { downloadAuditedApplicationBundle } from './bundle'

const snapshot = { job: { company: 'Example', role: 'Engineer' }, resume: { id: 'resume', name: 'CV', updatedAt: '2026-10-30T10:00:00.000Z', templateId: 'clean', content: { contact: {} } }, coverLetter: null, audit: {} }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue(snapshot)
  mocks.same.mockReturnValue(true)
  mocks.render.mockResolvedValue({})
  mocks.toBlob.mockResolvedValue(new Blob(['pdf']))
})

describe('audited application browser export', () => {
  it('saves only after rendering and re-reading the same audited snapshot', async () => {
    await downloadAuditedApplicationBundle('job', 'user', () => true)
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.same).toHaveBeenCalledWith(snapshot, snapshot)
    expect(mocks.save).toHaveBeenCalledOnce()
  })
  it.each(['.', '..', '...', '. .', '.. '])('never creates traversal paths for company or role %s', async name => {
    const malicious = { ...snapshot, job: { company: name, role: name } }
    mocks.read.mockResolvedValue(malicious)
    await downloadAuditedApplicationBundle('job', 'user', () => true)
    expect(mocks.folder).toHaveBeenCalledWith('Untitled/Untitled')
    expect(mocks.save.mock.calls[0][1]).toMatch(/^Untitled_Untitled_/)
  })
  it('does not render or save when the initial snapshot fails', async () => {
    mocks.read.mockRejectedValueOnce(new Error('invalid'))
    await expect(downloadAuditedApplicationBundle('job', 'user', () => true)).rejects.toThrow()
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not save when materials change while rendering', async () => {
    mocks.same.mockReturnValue(false)
    await expect(downloadAuditedApplicationBundle('job', 'user', () => true)).rejects.toThrow(/changed/)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not save when the user session changes during rendering', async () => {
    let current = true
    mocks.toBlob.mockImplementation(async () => { current = false; return new Blob(['pdf']) })
    await expect(downloadAuditedApplicationBundle('job', 'user', () => current)).rejects.toThrow(/session/)
    expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not save if the session changes while the final snapshot is loading', async () => {
    let current = true
    mocks.read.mockResolvedValueOnce(snapshot).mockImplementationOnce(async () => { current = false; return snapshot })
    await expect(downloadAuditedApplicationBundle('job', 'user', () => current)).rejects.toThrow(/changed/)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
