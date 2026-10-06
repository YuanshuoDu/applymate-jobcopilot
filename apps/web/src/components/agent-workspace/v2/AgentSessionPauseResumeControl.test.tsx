import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import {
  AgentSessionPauseResumeControl,
  parseAgentSessionControlStatus,
  postAgentSessionControl,
  startAgentSessionControlRefresh,
  stableAgentSessionControlMessage,
  type AgentSessionControlTurn,
} from './AgentSessionPauseResumeControl'

const activeTurn: AgentSessionControlTurn = { id: 'turn/1', revision: 7, status: 'in_progress' }

function response(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('AgentSessionPauseResumeControl', () => {
  it('accepts only canonical durable control statuses', () => {
    for (const status of ['running', 'pausing', 'paused', 'resuming']) expect(parseAgentSessionControlStatus(status)).toBe(status)
    for (const status of ['waiting_for_user', 'completed', 'failed', null, {}]) expect(parseAgentSessionControlStatus(status)).toBeNull()
  })

  it('renders durable running/paused states and an action only for actionable states', () => {
    const render = (sessionStatus: 'running' | 'pausing' | 'paused' | 'resuming') => renderToStaticMarkup(
      <I18nProvider><AgentSessionPauseResumeControl sessionId="session-1" sessionStatus={sessionStatus} activeTurn={activeTurn} onPause={vi.fn()} onResume={vi.fn()} /></I18nProvider>,
    )
    expect(render('running')).toContain(`data-agent-session-durable-status="running">${translate('en', 'agent.running')}</div>`)
    expect(render('running')).toContain(translate('en', 'agent.pause'))
    expect(render('paused')).toContain(`data-agent-session-durable-status="paused">${translate('en', 'agent.paused')}</div>`)
    expect(render('paused')).toContain(translate('en', 'agent.resume'))
    expect(render('pausing')).toContain('data-agent-session-durable-status="pausing"')
    expect(render('pausing')).not.toContain('<button')
    expect(render('resuming')).not.toContain('<button')
  })

  it('keeps a message ID stable for retry of one action and rotates it when Turn revision changes', () => {
    const first = stableAgentSessionControlMessage('pause', 'session-1', activeTurn, null)
    expect(stableAgentSessionControlMessage('pause', 'session-1', activeTurn, first)).toBe(first)
    expect(stableAgentSessionControlMessage('pause', 'session-1', { ...activeTurn, revision: 8 }, first).id).not.toBe(first.id)
    expect(stableAgentSessionControlMessage('resume', 'session-1', activeTurn, first).id).not.toBe(first.id)
  })

  it('posts matching body and idempotency key and accepts requested/duplicate acknowledgments', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ sessionId: 'session/one', turnId: 'turn/1', action: 'pause', status: 'pausing', disposition: 'requested' }))
    const command = { expectedTurnId: 'turn/1', expectedRevision: 7, clientMessageId: 'control-1' }
    await expect(postAgentSessionControl('session/one', 'pause', command, fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2Fone/control', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'control-1' },
      body: JSON.stringify({ action: 'pause', ...command }),
    }))

    fetcher.mockResolvedValueOnce(response({ sessionId: 'session/one', turnId: 'turn/1', action: 'resume', status: 'resuming', disposition: 'duplicate' }, 200))
    await expect(postAgentSessionControl('session/one', 'resume', { ...command, clientMessageId: 'control-2' }, fetcher)).resolves.toBeUndefined()
  })

  it('rejects failed or mismatched acknowledgments without exposing server details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ sessionId: 'session-1', turnId: 't', action: 'resume', status: 'resuming', disposition: 'requested', error: 'private detail' }))
    await expect(postAgentSessionControl('session-1', 'pause', { expectedTurnId: 't', expectedRevision: 1, clientMessageId: 'm' }, fetcher)).rejects.toThrow('status 202')
    fetcher.mockResolvedValueOnce(response({ error: 'private detail' }, 409))
    await expect(postAgentSessionControl('session-1', 'pause', { expectedTurnId: 't', expectedRevision: 1, clientMessageId: 'm' }, fetcher)).rejects.toThrow('status 409')
  })

  it('does not render controls without the authenticated current Turn or a canonical control state', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentSessionPauseResumeControl sessionId="session-1" sessionStatus={null} activeTurn={activeTurn} onPause={vi.fn()} onResume={vi.fn()} /></I18nProvider>)
    const noTurn = renderToStaticMarkup(<I18nProvider><AgentSessionPauseResumeControl sessionId="session-1" sessionStatus="running" activeTurn={null} onPause={vi.fn()} onResume={vi.fn()} /></I18nProvider>)
    expect(html).toBe('')
    expect(noTurn).toBe('')
  })

  it('bounds transitional refreshes and refreshes both canonical session and Turn state', async () => {
    vi.useFakeTimers()
    try {
      const refreshSession = vi.fn()
      const refreshTurn = vi.fn()
      startAgentSessionControlRefresh('resuming', refreshSession, refreshTurn)
      await vi.advanceTimersByTimeAsync(12_000)
      expect(refreshSession).toHaveBeenCalledTimes(12)
      expect(refreshTurn).toHaveBeenCalledTimes(12)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops transitional refreshes when the status settles or the component unmounts', async () => {
    vi.useFakeTimers()
    try {
      const refreshSession = vi.fn()
      const refreshTurn = vi.fn()
      const stop = startAgentSessionControlRefresh('pausing', refreshSession, refreshTurn)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(refreshSession).toHaveBeenCalledTimes(1)
      expect(refreshTurn).toHaveBeenCalledTimes(1)
      stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(refreshSession).toHaveBeenCalledTimes(1)
      expect(refreshTurn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when durable state is settled', async () => {
    vi.useFakeTimers()
    try {
      const refreshSession = vi.fn()
      const refreshTurn = vi.fn()
      const stop = startAgentSessionControlRefresh('paused', refreshSession, refreshTurn)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(refreshSession).not.toHaveBeenCalled()
      expect(refreshTurn).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
