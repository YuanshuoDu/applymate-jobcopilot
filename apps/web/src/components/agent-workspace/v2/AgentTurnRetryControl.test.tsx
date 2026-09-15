import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import {
  AgentTurnRetryControl,
  createAgentTurnRetryMessageId,
  isCurrentAgentTurnRetryRequest,
  isRetryableRootTurn,
  postAgentTurnRetry,
  type AgentTurnRetryRequest,
} from './AgentTurnRetryControl'
import type { SupervisorTurnSummary } from './task-tree-projection'

const fetchMock = vi.fn<typeof fetch>()

const turn = (overrides: Partial<SupervisorTurnSummary> = {}): SupervisorTurnSummary => ({
  id: 'turn-failed', sessionId: 'session/one', source: 'message', goal: 'Find roles', status: 'failed', revision: 9,
  activeStepId: null, finalItemId: null, createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:01:00.000Z', completedAt: '2026-09-07T10:01:00.000Z', ...overrides,
})

function response(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => fetchMock.mockReset())

describe('AgentTurnRetryControl', () => {
  it('renders only for terminal selected root turns', () => {
    const render = (selected: SupervisorTurnSummary | null) => renderToStaticMarkup(
      <I18nProvider><AgentTurnRetryControl sessionId="session/one" turn={selected} controlGate="open" onAccepted={vi.fn()} /></I18nProvider>,
    )

    expect(render(turn())).toContain(`data-agent-turn-retry="true"`)
    for (const status of ['interrupted', 'cancelled']) expect(render(turn({ status }))).toContain(translate('en', 'agent.retry'))
    for (const status of ['queued', 'running', 'completed', 'waiting_for_user']) expect(render(turn({ status }))).toBe('')
    expect(render(null)).toBe('')
  })

  it('renders a disabled localized explanation while the authoritative gate is paused', () => {
    const html = renderToStaticMarkup(
      <I18nProvider><AgentTurnRetryControl sessionId="session/one" turn={turn()} controlGate="user_paused" onAccepted={vi.fn()} /></I18nProvider>,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('data-agent-turn-retry-paused="true"')
    expect(html).toContain(translate('en', 'agent.retryPaused'))
  })

  it('posts encoded ids, JSON content, click revision, and matching idempotency key', async () => {
    fetchMock.mockResolvedValue(response({ inputId: 'input-1', turnId: 'turn-new', disposition: 'started', sequence: '12' }))
    const request: AgentTurnRetryRequest = {
      sessionId: 'session/one', turnId: 'turn/failed', expectedRevision: 9, clientMessageId: 'retry-message-1',
    }

    await expect(postAgentTurnRetry(request, fetchMock)).resolves.toMatchObject({ disposition: 'started' })
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session%2Fone/turns/turn%2Ffailed/retry', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-message-1' },
      body: JSON.stringify({ clientMessageId: 'retry-message-1', expectedRevision: 9 }),
    }))
  })

  it('accepts duplicate results and creates unique fallback-safe client ids', async () => {
    fetchMock.mockResolvedValue(response({ inputId: 'input-1', turnId: 'turn-new', disposition: 'duplicate', sequence: '12' }, 200))
    await expect(postAgentTurnRetry({ sessionId: 's', turnId: 't', expectedRevision: 1, clientMessageId: createAgentTurnRetryMessageId() }, fetchMock)).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(createAgentTurnRetryMessageId()).not.toBe(createAgentTurnRetryMessageId())
  })

  it('rejects non-2xx and malformed responses without exposing a server message', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'opaque server detail' } }, 409))
    await expect(postAgentTurnRetry({ sessionId: 's', turnId: 't', expectedRevision: 1, clientMessageId: 'retry-message-2' }, fetchMock)).rejects.toThrow('status 409')
    fetchMock.mockResolvedValueOnce(response({ disposition: 'started' }))
    await expect(postAgentTurnRetry({ sessionId: 's', turnId: 't', expectedRevision: 1, clientMessageId: 'retry-message-3' }, fetchMock)).rejects.toThrow('invalid response')
  })

  it('discards late responses after session or same-session selection changes', () => {
    expect(isCurrentAgentTurnRetryRequest(2, 1, 'session-a:turn-1:4:failed', 'session-a:turn-1:4:failed')).toBe(false)
    expect(isCurrentAgentTurnRetryRequest(3, 3, 'session-a:turn-2:1:failed', 'session-a:turn-1:4:failed')).toBe(false)
    expect(isCurrentAgentTurnRetryRequest(4, 4, 'session-a:turn-1:4:failed', 'session-a:turn-1:4:failed')).toBe(true)
  })

  it('keeps retry eligibility exact to the terminal statuses', () => {
    expect(isRetryableRootTurn(turn({ status: 'failed' }))).toBe(true)
    expect(isRetryableRootTurn(turn({ status: 'interrupted' }))).toBe(true)
    expect(isRetryableRootTurn(turn({ status: 'cancelled' }))).toBe(true)
    expect(isRetryableRootTurn(turn({ status: 'error' }))).toBe(false)
  })
})
