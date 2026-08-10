import { afterEach, describe, expect, it, vi } from 'vitest'
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})
import { fetchRecentGmailMessages, GmailApiError } from './gmail-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRecentGmailMessages', () => {
  it('fetches and parses full Gmail messages without making unmocked requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const plain = Buffer.from('Thank you for applying').toString('base64url')
    const html = Buffer.from('<p>Thank you for applying</p>').toString('base64url')

    fetchMock
      .mockResolvedValueOnce(Response.json({ messages: [{ id: 'message-1' }, { id: 'message-2' }] }))
      .mockResolvedValueOnce(Response.json({
        id: 'message-1',
        threadId: 'thread-1',
        internalDate: '1760000000000',
        snippet: 'Application received',
        payload: {
          headers: [
            { name: 'From', value: 'Acme Talent <talent@acme.example>' },
            { name: 'Subject', value: 'Application received: Engineer at Acme' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: plain } },
            { mimeType: 'text/html', body: { data: html } },
          ],
        },
      }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))

    const messages = await fetchRecentGmailMessages('access-token', new Date('2026-01-02T12:00:00Z'))

    expect(messages).toEqual([expect.objectContaining({
      id: 'message-1',
      threadId: 'thread-1',
      senderName: 'Acme Talent',
      senderEmail: 'talent@acme.example',
      subject: 'Application received: Engineer at Acme',
      text: 'Thank you for applying',
      html: '<p>Thank you for applying</p>',
      receivedAt: new Date(1_760_000_000_000),
    })])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(listUrl.searchParams.get('q')).toContain('after:2026/01/02')
    expect(listUrl.searchParams.get('q')).toContain('job alert')
  })

  it('returns a typed error when Gmail rejects the message list request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchRecentGmailMessages('access-token', null)).rejects.toEqual(
      expect.objectContaining<GmailApiError>({
        name: 'GmailApiError',
        status: 403,
        message: 'Could not list Gmail messages',
      }),
    )
  })

  it('bounds concurrent message fetches during a large sync', async () => {
    let callCount = 0
    let active = 0
    let maxActive = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) return Response.json({ messages: Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}` })) })
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 0))
      active -= 1
      return Response.json({ id: `message-${callCount}`, payload: { headers: [], parts: [] } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await fetchRecentGmailMessages('access-token', null)

    expect(maxActive).toBeLessThanOrEqual(8)
  })
})
