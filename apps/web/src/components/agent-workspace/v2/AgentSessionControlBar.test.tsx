import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import {
  AgentSessionControlBar,
  AgentSessionControlBarView,
  createAgentSessionControlMessageId,
  formatAgentSessionControlError,
  isCurrentAgentSessionControlRequest,
  postAgentSessionControl,
  readAgentSessionControlError,
} from './AgentSessionControlBar'

const fetchMock = vi.fn<typeof fetch>()

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('AgentSessionControlBar', () => {
  it('renders the pause action and authoritative running state', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionControlBar sessionId="session-1" controlGate="open" controlRevision={4} /></I18nProvider>)
    expect(html).toContain(translate('en', 'agent.pause'))
    expect(html).toContain(translate('en', 'agent.running'))
    expect(html).toContain('data-agent-session-control="true"')
  })

  it('renders resume for a paused session without changing the gate locally', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionControlBar sessionId="session-1" controlGate="user_paused" controlRevision={5} /></I18nProvider>)
    expect(html).toContain(translate('en', 'agent.resume'))
    expect(html).toContain(translate('en', 'agent.paused'))
    expect(html).not.toContain(translate('en', 'agent.pause'))
  })

  it('shows a disabled pending control and a visible alert error', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionControlBarView
      controlGate="open"
      pendingOperation="pause"
      error="Action failed (409)"
      onControl={vi.fn()}
    /></I18nProvider>)
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Action failed (409)')
  })

  it('posts pause with the encoded session, expected revision, and idempotency headers', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(response({ operation: 'pause' }, 202))

    await postAgentSessionControl({ sessionId: 'session/one', operation: 'pause', expectedRevision: 7, clientMessageId: 'pause-message-1' })

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session%2Fone/pause', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pause-message-1' },
      body: JSON.stringify({ clientMessageId: 'pause-message-1', expectedRevision: 7 }),
    }))
  })

  it('posts resume with the click-time revision and a unique generated message id', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(response({ operation: 'resume' }, 202))

    await postAgentSessionControl({ sessionId: 'session-1', operation: 'resume', expectedRevision: 12 })
    await postAgentSessionControl({ sessionId: 'session-1', operation: 'resume', expectedRevision: 13 })

    const first = fetchMock.mock.calls[0]
    const second = fetchMock.mock.calls[1]
    const firstInit = first[1] as RequestInit
    const secondInit = second[1] as RequestInit
    const firstBody = JSON.parse(String(firstInit.body)) as { clientMessageId: string; expectedRevision: number }
    const secondBody = JSON.parse(String(secondInit.body)) as { clientMessageId: string; expectedRevision: number }
    expect(first[0]).toBe('/api/agent/sessions/session-1/resume')
    expect(second[0]).toBe('/api/agent/sessions/session-1/resume')
    expect(firstBody.expectedRevision).toBe(12)
    expect(secondBody.expectedRevision).toBe(13)
    expect(firstBody.clientMessageId).not.toBe(secondBody.clientMessageId)
    expect((firstInit.headers as Record<string, string>)['Idempotency-Key']).toBe(firstBody.clientMessageId)
  })

  it('safely reads object and string error envelopes and keeps 409 visible', () => {
    expect(readAgentSessionControlError({ error: { message: 'stale gate' } })).toBe('stale gate')
    expect(readAgentSessionControlError({ error: 'request failed' })).toBe('request failed')
    expect(readAgentSessionControlError({ error: { message: { unsafe: true } } })).toBeNull()
    expect(formatAgentSessionControlError(409, { error: { message: 'stale gate' } }, 'Action failed')).toBe('Action failed (409)')
  })

  it('does not render or request anything without a session', () => {
    vi.stubGlobal('fetch', fetchMock)
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionControlBar sessionId={null} controlGate="open" controlRevision={0} /></I18nProvider>)
    expect(html).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adds a sequence to every generated message id for test-environment fallbacks', () => {
    expect(createAgentSessionControlMessageId()).not.toBe(createAgentSessionControlMessageId())
  })

  it('discards responses belonging to a session that is no longer selected', () => {
    expect(isCurrentAgentSessionControlRequest(2, 1)).toBe(false)
    expect(isCurrentAgentSessionControlRequest(1, 1)).toBe(true)
  })

  it('shows a visible generic error for malformed non-2xx responses', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('not-json', { status: 503 }))
    await expect(postAgentSessionControl({ sessionId: 'session-1', operation: 'pause', expectedRevision: 2, clientMessageId: 'pause-message-2' })).rejects.toThrow('status 503')
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionControlBarView
      controlGate="open"
      pendingOperation={null}
      error={formatAgentSessionControlError(503, null, translate('en', 'agent.actionFailed'))}
      onControl={vi.fn()}
    /></I18nProvider>)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Action failed (503)')
  })
})
