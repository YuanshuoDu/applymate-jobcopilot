import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openApplicationPackPrintResponse, saveApplicationPackResponse } from './download-response'

const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }

beforeEach(() => {
  vi.useFakeTimers()
  link.href = ''; link.download = ''; link.click.mockClear(); link.remove.mockClear()
  vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(link), body: { appendChild: vi.fn() } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:application-pack')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('extension ZIP download', () => {
  it('starts a browser download without requesting filesystem or downloads permissions', async () => {
    const response = new Response('PK-zip', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': "attachment; filename*=UTF-8''Example%20Company.zip" } })
    expect(await saveApplicationPackResponse(response)).toEqual({ filename: 'Example Company.zip' })
    expect(link.href).toBe('blob:application-pack')
    expect(link.download).toBe('Example Company.zip')
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:application-pack')
  })

  it('does not save an HTML login page or empty response as a ZIP', async () => {
    await expect(saveApplicationPackResponse(new Response('Login', { headers: { 'Content-Type': 'text/html' } }))).rejects.toThrow('did not return an application ZIP')
    await expect(saveApplicationPackResponse(new Response('', { headers: { 'Content-Type': 'application/zip' } }))).rejects.toThrow('ZIP is empty')
    expect(link.click).not.toHaveBeenCalled()
  })

  it('uses a fallback for a malformed header and strips path characters', async () => {
    await saveApplicationPackResponse(new Response('zip', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': "filename*=UTF-8''%GG" } }))
    expect(link.download).toBe('ApplyMate-application-pack.zip')
    await saveApplicationPackResponse(new Response('zip', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': "filename*=UTF-8''A%2FB.zip" } }))
    expect(link.download).toBe('A-B.zip')
  })

  it('opens the authenticated print HTML without putting a bearer token into a URL', async () => {
    const create = vi.fn().mockResolvedValue({ id: 7 })
    vi.stubGlobal('chrome', { tabs: { create } })
    await openApplicationPackPrintResponse(new Response('<html>Print view</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: 'blob:application-pack' })
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:application-pack')
  })

  it('does not open a non-HTML or empty print response', async () => {
    await expect(openApplicationPackPrintResponse(Response.json({ error: 'Denied' }))).rejects.toThrow('did not return a print view')
    await expect(openApplicationPackPrintResponse(new Response('', { headers: { 'Content-Type': 'text/html' } }))).rejects.toThrow('print view is empty')
  })
})
