'use client'

import React, { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import type { SessionPauseBlocker } from './session-pause-blocker-projection'

export type AgentSessionControlStatus = 'running' | 'pausing' | 'paused' | 'resuming'
export type AgentSessionControlAction = 'pause' | 'resume'

const CONTROL_REFRESH_INTERVAL_MS = 1_000
const CONTROL_REFRESH_MAX_ATTEMPTS = 12

export interface AgentSessionControlTurn {
  readonly id: string
  readonly revision: number
  readonly status: string
}

export interface AgentSessionControlCommand {
  readonly expectedTurnId: string
  readonly expectedRevision: number
  readonly clientMessageId: string
}

export interface AgentSessionPauseResumeControlProps {
  readonly sessionId: string
  readonly sessionStatus: AgentSessionControlStatus | null
  readonly activeTurn: AgentSessionControlTurn | null
  readonly pauseBlocker?: SessionPauseBlocker | null
  readonly onPause: (command: AgentSessionControlCommand) => Promise<void>
  readonly onResume: (command: AgentSessionControlCommand) => Promise<void>
}

const PAUSE_BLOCKER_COPY = {
  en: {
    label: 'Pause is waiting on',
    step: 'A step still needs to settle.',
    external_operation: 'An external operation is still active.',
    child_task: 'A child task is still active.',
    recovery: 'Waiting for the agent to confirm its state.',
  },
  zh: {
    label: '暂停仍在等待',
    step: '仍有步骤需要完成。',
    external_operation: '外部操作仍在进行。',
    child_task: '子任务仍在运行。',
    recovery: '正在等待 Agent 确认当前状态。',
  },
} as const

function visiblePauseBlockerLabels(
  sessionStatus: AgentSessionControlStatus | null,
  activeTurnId: string | null,
  blocker: SessionPauseBlocker | null | undefined,
  lang: string,
): readonly string[] {
  if (sessionStatus !== 'pausing' || !activeTurnId || blocker?.turnId !== activeTurnId) return []
  const copy = lang === 'zh' ? PAUSE_BLOCKER_COPY.zh : PAUSE_BLOCKER_COPY.en
  return [...new Set(blocker.reasons)].flatMap(reason => {
    const label = copy[reason]
    return typeof label === 'string' ? [label] : []
  })
}

export function parseAgentSessionControlStatus(value: unknown): AgentSessionControlStatus | null {
  return value === 'running' || value === 'pausing' || value === 'paused' || value === 'resuming' ? value : null
}

export function startAgentSessionControlRefresh(
  status: AgentSessionControlStatus | null,
  refetchSession: () => unknown,
  refetchTurn: () => unknown,
): () => void {
  if (status !== 'pausing' && status !== 'resuming') return () => undefined
  let cancelled = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout>
  const refresh = async () => {
    attempts += 1
    await Promise.allSettled([
      Promise.resolve().then(refetchSession),
      Promise.resolve().then(refetchTurn),
    ])
    if (!cancelled && attempts < CONTROL_REFRESH_MAX_ATTEMPTS) {
      timer = setTimeout(() => void refresh(), CONTROL_REFRESH_INTERVAL_MS)
    }
  }
  timer = setTimeout(() => void refresh(), CONTROL_REFRESH_INTERVAL_MS)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

export function useAgentSessionControlRefresh(
  sessionId: string | null,
  status: AgentSessionControlStatus | null,
  refetchSession: () => unknown,
  refetchTurn: () => unknown,
): void {
  useEffect(() => {
    if (!sessionId) return
    return startAgentSessionControlRefresh(status, refetchSession, refetchTurn)
  }, [refetchSession, refetchTurn, sessionId, status])
}

export function createAgentSessionControlMessageId(): string {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-session-control-${id}`
}

export function stableAgentSessionControlMessage(
  action: AgentSessionControlAction,
  sessionId: string,
  turn: AgentSessionControlTurn,
  previous: { readonly key: string; readonly id: string } | null,
): { readonly key: string; readonly id: string } {
  const key = `${action}:${sessionId}:${turn.id}:${turn.revision}`
  return previous?.key === key ? previous : { key, id: createAgentSessionControlMessageId() }
}

export async function postAgentSessionControl(
  sessionId: string,
  action: AgentSessionControlAction,
  command: AgentSessionControlCommand,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(sessionId)}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.clientMessageId },
    body: JSON.stringify({ action, ...command }),
  })
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok || !isAcceptedControl(body, sessionId, command.expectedTurnId, action)) throw new Error(`Session control request failed with status ${response.status}`)
}

function isAcceptedControl(value: unknown, sessionId: string, turnId: string, action: AgentSessionControlAction): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.sessionId === sessionId
    && row.turnId === turnId
    && row.action === action
    && row.status === (action === 'pause' ? 'pausing' : 'resuming')
    && (row.disposition === 'requested' || row.disposition === 'duplicate')
}

export function AgentSessionPauseResumeControl({ sessionId, sessionStatus, activeTurn, pauseBlocker, onPause, onResume }: AgentSessionPauseResumeControlProps) {
  const { t, lang } = useI18n()
  const [pendingRequest, setPendingRequest] = useState<{ key: string; token: number } | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const messageRef = useRef<{ key: string; id: string } | null>(null)
  const pendingTokenRef = useRef<number | null>(null)
  const requestSequenceRef = useRef(0)
  const stateKey = `${sessionId}:${sessionStatus ?? 'unknown'}:${activeTurn?.id ?? 'none'}:${activeTurn?.revision ?? 'none'}`
  const previousStateKeyRef = useRef(stateKey)
  if (previousStateKeyRef.current !== stateKey) {
    previousStateKeyRef.current = stateKey
    messageRef.current = null
    pendingTokenRef.current = null
  }

  if (!sessionStatus || !activeTurn) return null
  const action = sessionStatus === 'running' ? 'pause' : sessionStatus === 'paused' ? 'resume' : null
  const pending = pendingRequest?.key === stateKey && pendingRequest.token === pendingTokenRef.current
  const currentError = errorKey === stateKey
  const statusLabel = sessionStatus === 'running' ? t('agent.running')
    : sessionStatus === 'paused' ? t('agent.paused')
      : sessionStatus === 'pausing' ? `${t('agent.pause')}…` : `${t('agent.resume')}…`
  const pauseBlockerLabels = visiblePauseBlockerLabels(sessionStatus, activeTurn.id, pauseBlocker, lang)

  const requestControl = () => {
    if (!action || pending || pendingTokenRef.current !== null) return
    const stable = stableAgentSessionControlMessage(action, sessionId, activeTurn, messageRef.current)
    messageRef.current = stable
    const token = ++requestSequenceRef.current
    pendingTokenRef.current = token
    setPendingRequest({ key: stateKey, token })
    setErrorKey(null)
    const onControl = action === 'pause' ? onPause : onResume
    const command = { expectedTurnId: activeTurn.id, expectedRevision: activeTurn.revision, clientMessageId: stable.id }
    void Promise.resolve().then(() => onControl(command))
      .catch(() => { if (previousStateKeyRef.current === stateKey) setErrorKey(stateKey) })
      .finally(() => {
        if (pendingTokenRef.current !== token) return
        pendingTokenRef.current = null
        setPendingRequest(null)
      })
  }

  return (
    <section aria-label="Session controls" data-agent-session-control="true" style={panelStyle}>
      <div role="status" aria-live="polite" data-agent-session-durable-status={sessionStatus}>
        {statusLabel}
        {pauseBlockerLabels.length > 0 && <ul aria-label={lang === 'zh' ? PAUSE_BLOCKER_COPY.zh.label : PAUSE_BLOCKER_COPY.en.label} data-agent-session-pause-blockers="true" style={pauseBlockerStyle}>
          {pauseBlockerLabels.map(label => <li key={label}>{label}</li>)}
        </ul>}
      </div>
      {action && <button type="button" onClick={requestControl} disabled={pending} aria-busy={pending} style={buttonStyle}>
        {pending ? 'Sending…' : t(action === 'pause' ? 'agent.pause' : 'agent.resume')}
      </button>}
      {currentError && <p role="alert" style={errorStyle}>Control request failed. You can retry safely.</p>}
    </section>
  )
}

const panelStyle: React.CSSProperties = { display: 'grid', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)' }
const pauseBlockerStyle: React.CSSProperties = { margin: 0, paddingLeft: 18, color: 'var(--text-muted)', fontSize: 11 }
const buttonStyle: React.CSSProperties = { justifySelf: 'start', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 600 }
const errorStyle: React.CSSProperties = { margin: 0, color: 'var(--c-danger)', fontSize: 11 }
