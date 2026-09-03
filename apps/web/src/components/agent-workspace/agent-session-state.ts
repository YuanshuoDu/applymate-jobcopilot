'use client'

import { useCallback, useEffect, useSyncExternalStore, useState } from 'react'

export const AGENT_SESSION_QUERY_PARAM = 'sessionId'

export type ActiveTurnStatus =
  | 'queued'
  | 'in_progress'
  | 'waiting_for_dependency'
  | 'waiting_for_approval'
  | 'waiting_for_user'

export interface ActiveTurnDto {
  id: string
  status: ActiveTurnStatus
  revision: number
}

export interface AgentTurnsResponse {
  schemaVersion?: string
  turns?: unknown[]
  projection?: {
    activeTurnId?: string | null
    activeTurn?: unknown
    queuedInputCount?: number
  }
}

export interface AgentSessionState {
  activeTurn: ActiveTurnDto | null
  queuedInputCount: number
}

const ACTIVE_TURN_STATUSES = new Set<ActiveTurnStatus>([
  'queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user',
])

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function parseActiveTurn(value: unknown): ActiveTurnDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = nonEmptyString(row.id)
  const status = row.status
  const revision = row.revision
  if (!id || typeof status !== 'string' || !ACTIVE_TURN_STATUSES.has(status as ActiveTurnStatus)) return null
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null
  return { id, status: status as ActiveTurnStatus, revision }
}

export function parseAgentTurnsResponse(value: unknown): AgentSessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { activeTurn: null, queuedInputCount: 0 }
  const response = value as AgentTurnsResponse
  const projection = response.projection
  const activeTurnId = nonEmptyString(projection?.activeTurnId)
  const projectionTurn = parseActiveTurn(projection?.activeTurn)
  const turns = Array.isArray(response.turns) ? response.turns : []
  const listedTurn = activeTurnId
    ? turns.map(parseActiveTurn).find((turn) => turn?.id === activeTurnId) ?? null
    : null
  const activeTurn = projectionTurn?.id === activeTurnId || !activeTurnId
    ? projectionTurn
    : listedTurn
  return {
    activeTurn,
    queuedInputCount: typeof projection?.queuedInputCount === 'number' && Number.isSafeInteger(projection.queuedInputCount) && projection.queuedInputCount >= 0
      ? Math.floor(projection.queuedInputCount)
      : 0,
  }
}

export function readAgentSessionId(href: string): string | null {
  try {
    return nonEmptyString(new URL(href, 'https://applymate.local').searchParams.get(AGENT_SESSION_QUERY_PARAM))
  } catch {
    return null
  }
}

export function agentSessionUrl(sessionId: string | null, href: string): string {
  const url = new URL(href, 'https://applymate.local')
  if (sessionId) url.searchParams.set(AGENT_SESSION_QUERY_PARAM, sessionId)
  else url.searchParams.delete(AGENT_SESSION_QUERY_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

const SESSION_URL_CHANGED = 'applymate:agent-session-url-changed'

function subscribeToAgentSessionUrl(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(SESSION_URL_CHANGED, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(SESSION_URL_CHANGED, onChange)
  }
}

export function useAgentSessionUrl() {
  const sessionId = useSyncExternalStore(
    subscribeToAgentSessionUrl,
    () => readAgentSessionId(window.location.href),
    () => null,
  )
  const setSessionId = useCallback((nextSessionId: string | null) => {
    if (typeof window === 'undefined') return
    const nextUrl = agentSessionUrl(nextSessionId, window.location.href)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl === currentUrl) return
    window.history.replaceState(window.history.state, '', nextUrl)
    window.dispatchEvent(new Event(SESSION_URL_CHANGED))
  }, [])
  return { sessionId, setSessionId }
}

export function useAgentSessionState(sessionId: string | null) {
  const [state, setState] = useState<AgentSessionState>({ activeTurn: null, queuedInputCount: 0 })
  const [stateSessionId, setStateSessionId] = useState<string | null>(sessionId)
  const [loading, setLoading] = useState(Boolean(sessionId))
  const [error, setError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const refetch = useCallback(() => setRefreshVersion((version) => version + 1), [])

  useEffect(() => {
    if (!sessionId) {
      setStateSessionId(null)
      setState({ activeTurn: null, queuedInputCount: 0 })
      setLoading(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    setStateSessionId(sessionId)
    setState({ activeTurn: null, queuedInputCount: 0 })
    setLoading(true)
    setError(null)
    void fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/turns?limit=1`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as unknown
        if (!response.ok) throw new Error(`Turn state failed (${response.status})`)
        if (!controller.signal.aborted) setState(parseAgentTurnsResponse(body))
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Turn state failed')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [sessionId, refreshVersion])

  const visibleState = stateSessionId === sessionId ? state : { activeTurn: null, queuedInputCount: 0 }
  return { ...visibleState, loading, error, refetch }
}
