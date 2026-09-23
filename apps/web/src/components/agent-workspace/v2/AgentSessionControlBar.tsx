'use client'

import React, { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'

import type { TimelineSessionControlGate } from './timeline-session-control'

export type AgentSessionControlOperation = 'pause' | 'resume'

export interface AgentSessionControlBarProps {
  readonly sessionId: string | null
  readonly controlGate: TimelineSessionControlGate
  readonly controlRevision: number
}

export interface AgentSessionControlBarViewProps {
  readonly controlGate: TimelineSessionControlGate
  readonly pendingOperation: AgentSessionControlOperation | null
  readonly error: string | null
  readonly onControl: () => void
}

interface SessionControlRequest {
  readonly sessionId: string
  readonly operation: AgentSessionControlOperation
  readonly expectedRevision: number
  readonly clientMessageId?: string
}

interface ErrorEnvelope {
  readonly error?: unknown
}

let clientMessageSequence = 0

/** Generates a unique id even when browser crypto is unavailable in tests. */
export function createAgentSessionControlMessageId(): string {
  clientMessageSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-session-control-${randomId}-${clientMessageSequence}`
}

/** Safely reads the two error envelope shapes returned by the session routes. */
export function readAgentSessionControlError(body: unknown): string | null {
  if (!isRecord(body)) return null
  const error = body.error
  const message = typeof error === 'string'
    ? error
    : isRecord(error) && typeof error.message === 'string' ? error.message : null
  const trimmed = message?.trim()
  return trimmed ? trimmed.slice(0, 256) : null
}

export function formatAgentSessionControlError(status: number, body: unknown, genericMessage: string): string {
  // Parse the server envelope for a stable request failure boundary. The UI
  // renders a localized message so server locale or opaque detail cannot mix.
  readAgentSessionControlError(body)
  return status > 0 ? `${genericMessage} (${status})` : genericMessage
}

/** Prevents a completed request from updating a later session selection. */
export function isCurrentAgentSessionControlRequest(currentSessionEpoch: number, requestSessionEpoch: number): boolean {
  return currentSessionEpoch === requestSessionEpoch
}

export async function postAgentSessionControl(request: SessionControlRequest): Promise<void> {
  const clientMessageId = request.clientMessageId ?? createAgentSessionControlMessageId()
  const response = await fetch(
    `/api/agent/sessions/${encodeURIComponent(request.sessionId)}/${request.operation}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': clientMessageId,
      },
      body: JSON.stringify({ clientMessageId, expectedRevision: request.expectedRevision }),
    },
  )
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new AgentSessionControlRequestError(response.status, readAgentSessionControlError(body))
}

export function AgentSessionControlBar({ sessionId, controlGate, controlRevision }: AgentSessionControlBarProps) {
  const { t } = useI18n()
  const [pendingOperation, setPendingOperation] = useState<AgentSessionControlOperation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionEpochRef = useRef(0)
  const previousSessionIdRef = useRef(sessionId)

  // Update during render so a response cannot win the small gap before the
  // session-change effect runs.
  if (previousSessionIdRef.current !== sessionId) {
    previousSessionIdRef.current = sessionId
    sessionEpochRef.current += 1
  }

  useEffect(() => {
    setPendingOperation(null)
    setError(null)
  }, [sessionId])

  if (!sessionId) return null

  const operation: AgentSessionControlOperation = controlGate === 'open' ? 'pause' : 'resume'
  const handleControl = () => {
    if (pendingOperation) return
    const expectedRevision = controlRevision
    const clientMessageId = createAgentSessionControlMessageId()
    const requestSessionEpoch = sessionEpochRef.current
    setPendingOperation(operation)
    setError(null)
    void postAgentSessionControl({ sessionId, operation, expectedRevision, clientMessageId })
      .catch(reason => {
        if (!isCurrentAgentSessionControlRequest(sessionEpochRef.current, requestSessionEpoch)) return
        if (reason instanceof AgentSessionControlRequestError) {
          setError(formatAgentSessionControlError(reason.status, reason.serverMessage, t('agent.actionFailed')))
          return
        }
        setError(t('agent.actionFailed'))
      })
      .finally(() => {
        if (isCurrentAgentSessionControlRequest(sessionEpochRef.current, requestSessionEpoch)) setPendingOperation(null)
      })
  }

  return <AgentSessionControlBarView
    controlGate={controlGate}
    pendingOperation={pendingOperation}
    error={error}
    onControl={handleControl}
  />
}

export function AgentSessionControlBarView({ controlGate, pendingOperation, error, onControl }: AgentSessionControlBarViewProps) {
  const { t } = useI18n()
  const paused = controlGate === 'user_paused'
  const actionLabel = paused ? t('agent.resume') : t('agent.pause')
  const stateLabel = paused ? t('agent.paused') : t('agent.running')

  return (
    <section aria-label={t('agent.executionControl')} data-agent-session-control="true" style={barStyle}>
      <div style={headerStyle}>
        <span style={eyebrowStyle}><span aria-hidden="true" style={{ ...statusDotStyle, background: paused ? 'var(--c-warning)' : 'var(--c-success)' }} />{t('agent.executionControl')}</span>
        <span data-agent-session-control-state="true" style={stateStyle}>{stateLabel}</span>
      </div>
      <button type="button" onClick={onControl} disabled={pendingOperation !== null} aria-label={actionLabel} style={{ ...buttonStyle, opacity: pendingOperation ? 0.72 : 1 }}>
        <span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span>
        {actionLabel}
      </button>
      {pendingOperation && <span role="status" aria-live="polite" data-agent-session-control-pending="true" style={pendingStyle}>{t('agent.working')}</span>}
      {error && <p role="alert" data-agent-session-control-error="true" style={errorStyle}>{error}</p>}
    </section>
  )
}

class AgentSessionControlRequestError extends Error {
  readonly status: number
  readonly serverMessage: string | null

  constructor(status: number, serverMessage: string | null) {
    super(`Agent session control request failed with status ${status}`)
    this.name = 'AgentSessionControlRequestError'
    this.status = status
    this.serverMessage = serverMessage
  }
}

function isRecord(value: unknown): value is ErrorEnvelope & Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const barStyle: React.CSSProperties = { display: 'grid', gap: 9, marginBottom: 12, padding: 11, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)', boxShadow: '0 1px 2px rgb(15 23 42 / 8%)' }
const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const eyebrowStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }
const statusDotStyle: React.CSSProperties = { width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%' }
const stateStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 11, fontWeight: 700 }
const buttonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 600 }
const pendingStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 10 }
const errorStyle: React.CSSProperties = { margin: 0, color: 'var(--c-danger)', fontSize: 10, lineHeight: 1.4 }
