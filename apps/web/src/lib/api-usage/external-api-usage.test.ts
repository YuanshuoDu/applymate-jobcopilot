import { describe, expect, it, vi } from 'vitest'
import { trackedExternalApiFetch } from './external-api-usage'

describe('trackedExternalApiFetch', () => {
  it('records numeric metadata and stable HTTP error codes only', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    const response = await trackedExternalApiFetch('https://resend.example.test/emails', { method: 'POST', body: 'private email body' }, { provider: 'resend', operation: 'send', credentialSource: 'platform' }, { request: vi.fn().mockResolvedValue(new Response('provider response body', { status: 429, headers: { 'content-length': '22' } })), create })
    expect(response.status).toBe(429)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'resend', status: 'error', httpStatus: 429, errorCode: 'http_429', inputBytes: 18, outputBytes: 22 }))
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('provider response body')
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('private email body')
  })
  it('classifies aborts as timeout without persisting exception text', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    await expect(trackedExternalApiFetch('https://gmail.example.test', {}, { provider: 'gmail', operation: 'list', credentialSource: 'user' }, { request: vi.fn().mockRejectedValue(new DOMException('secret response body', 'AbortError')), create })).rejects.toThrow()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'timeout' }))
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('secret response body')
  })

  it('classifies native timeout errors as timeout', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    await expect(trackedExternalApiFetch('https://gmail.example.test', {}, { provider: 'gmail', operation: 'list', credentialSource: 'user' }, { request: vi.fn().mockRejectedValue(new DOMException('private body', 'TimeoutError')), create })).rejects.toThrow()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'timeout' }))
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('private body')
  })

  it('measures a response body when content-length is missing', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(new Response('provider payload'))

    await trackedExternalApiFetch('https://gmail.example.test', {}, { provider: 'gmail', operation: 'list', credentialSource: 'user' }, { request, create })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ outputBytes: new TextEncoder().encode('provider payload').byteLength }))
  })
})
