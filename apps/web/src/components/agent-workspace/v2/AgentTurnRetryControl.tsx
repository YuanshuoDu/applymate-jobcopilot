'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'

import type { SupervisorTurnSummary } from './task-tree-projection'

const RETRYABLE_STATUSES = new Set(['failed', 'interrupted', 'cancelled'])

export interface AgentTurnRetryControlProps {
  readonly sessionId: string
  readonly turn: SupervisorTurnSummary | null
  readonly onAccepted: () => void
}

export interface AgentTurnRetryRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly expectedRevision: number
  readonly clientMessageId: string
}

export interface AgentTurnRetryResult {
  readonly inputId: string
  readonly turnId: string
  readonly disposition: 'started' | 'duplicate'
  readonly sequence: string
}

let clientMessageSequence = 0

/** Generates a fresh id even when browser crypto is unavailable in tests. */
export function createAgentTurnRetryMessageId(): string {
  clientMessageSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-turn-retry-${randomId}-${clientMessageSequence}`
}

export function isRetryableRootTurn(turn: SupervisorTurnSummary | null): boolean {
  return Boolean(turn && RETRYABLE_STATUSES.has(turn.status))
}

/** Prevents a late response from changing a later turn/session selection. */
export function isCurrentAgentTurnRetryRequest(
  currentEpoch: number,
  requestEpoch: number,
  currentSelectionKey: string,
  requestSelectionKey: string,
): boolean {
  return currentEpoch === requestEpoch && currentSelectionKey === requestSelectionKey
}

export async function postAgentTurnRetry(
  request: AgentTurnRetryRequest,
  fetcher: typeof fetch = fetch,
): Promise<AgentTurnRetryResult> {
  const response = await fetcher(
    `/api/agent/sessions/${encodeURIComponent(request.sessionId)}/turns/${encodeURIComponent(request.turnId)}/retry`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': request.clientMessageId,
      },
      body: JSON.stringify({ clientMessageId: request.clientMessageId, expectedRevision: request.expectedRevision }),
    },
  )
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new AgentTurnRetryRequestError(response.status)
  return parseAgentTurnRetryResult(body)
}

export function AgentTurnRetryControl({ sessionId, turn, onAccepted }: AgentTurnRetryControlProps) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<'accepted' | 'failed' | null>(null)
  const selectionKey = turn ? `${sessionId}:${turn.id}:${turn.revision}:${turn.status}` : `${sessionId}:none`
  const requestEpochRef = useRef(0)
  const previousSelectionKeyRef = useRef(selectionKey)

  // Advance during render so a response cannot win the gap before the effect
  // for a new session or selected Turn runs, including a same-session reselect.
  if (previousSelectionKeyRef.current !== selectionKey) {
    previousSelectionKeyRef.current = selectionKey
    requestEpochRef.current += 1
  }

  useEffect(() => {
    setPending(false)
    setFeedback(null)
  }, [selectionKey])

  const handleRetry = useCallback(() => {
    if (pending || !turn) return
    const requestEpoch = requestEpochRef.current
    const requestSelectionKey = selectionKey
    const clientMessageId = createAgentTurnRetryMessageId()
    setPending(true)
    setFeedback(null)
    void postAgentTurnRetry({
      sessionId,
      turnId: turn.id,
      expectedRevision: turn.revision,
      clientMessageId,
    }).then(() => {
      if (!isCurrentAgentTurnRetryRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) return
      setFeedback('accepted')
      onAccepted()
    }).catch(() => {
      if (!isCurrentAgentTurnRetryRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) return
      setFeedback('failed')
    }).finally(() => {
      if (isCurrentAgentTurnRetryRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) setPending(false)
    })
  }, [onAccepted, pending, selectionKey, sessionId, turn])

  if (!isRetryableRootTurn(turn)) return null

  return (
    <section aria-label={t('agent.retry')} data-agent-turn-retry="true" style={panelStyle}>
      <button
        type="button"
        onClick={handleRetry}
        disabled={pending}
        aria-label={t('agent.retry')}
        style={{ ...buttonStyle, opacity: pending ? 0.68 : 1 }}
      >
        {pending ? t('agent.retrying') : t('agent.retry')}
      </button>
      {feedback === 'accepted' && <p role="status" aria-live="polite" data-agent-turn-retry-status="accepted" style={hintStyle}>{t('agent.retryAccepted')}</p>}
      {feedback === 'failed' && <p role="alert" data-agent-turn-retry-error="true" style={errorStyle}>{t('agent.retryFailed')}</p>}
    </section>
  )
}

class AgentTurnRetryRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Agent turn retry request failed with status ${status}`)
    this.name = 'AgentTurnRetryRequestError'
    this.status = status
  }
}

function parseAgentTurnRetryResult(value: unknown): AgentTurnRetryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent turn retry returned an invalid response')
  const row = value as Record<string, unknown>
  if (typeof row.inputId !== 'string' || typeof row.turnId !== 'string' || typeof row.sequence !== 'string') throw new Error('Agent turn retry returned an invalid response')
  if (row.disposition !== 'started' && row.disposition !== 'duplicate') throw new Error('Agent turn retry returned an invalid disposition')
  return { inputId: row.inputId, turnId: row.turnId, disposition: row.disposition, sequence: row.sequence }
}

const panelStyle: React.CSSProperties = { display: 'grid', gap: 6, paddingTop: 8 }
const buttonStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 600 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const errorStyle: React.CSSProperties = { ...hintStyle, color: 'var(--c-danger)' }
