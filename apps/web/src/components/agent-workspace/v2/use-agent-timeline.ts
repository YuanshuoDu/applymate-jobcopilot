'use client'

import { useEffect, useMemo, useState } from 'react'

import { streamAgentTimeline } from './stream-client'
import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineConnection, type TimelineItem, type TimelineState } from './timeline-reducer'

export interface AgentTimelineSnapshot {
  readonly sessionId: string | null
  readonly items: readonly TimelineItem[]
  readonly lastEventId: string | null
  readonly lifecycleRevision: number
  readonly connection: TimelineConnection
  readonly restoring: boolean
  readonly error: string | null
}

/** Returns only the items belonging to the currently selected session. */
export function timelineItemsForSession(state: TimelineState, sessionId: string | null): TimelineItem[] {
  if (!sessionId || state.sessionId !== sessionId) return []
  return selectTimelineItems(state)
}

/** Owns the single V2 timeline stream for a page and cleans it up on switch. */
export function useAgentTimeline(sessionId: string | null): AgentTimelineSnapshot {
  const [state, setState] = useState<TimelineState>(() => createTimelineState(sessionId ?? 'draft'))
  const [restoring, setRestoring] = useState(Boolean(sessionId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState(createTimelineState(sessionId ?? 'draft'))
    setRestoring(Boolean(sessionId))
    setError(null)

    if (!sessionId) {
      return () => controller.abort()
    }

    void streamAgentTimeline({
      sessionId,
      signal: controller.signal,
      onConnected: () => {
        if (!controller.signal.aborted) setRestoring(false)
      },
      dispatch: action => {
        if (controller.signal.aborted) return
        if (action.type === 'connected' || action.type === 'disconnected') setRestoring(false)
        setState(current => timelineReducer(current, action))
      },
    }).then(() => {
      if (!controller.signal.aborted) setRestoring(false)
    }).catch(reason => {
      if (controller.signal.aborted) return
      setRestoring(false)
      setError(reason instanceof Error ? reason.message : 'Timeline stream failed')
    })

    return () => controller.abort()
  }, [sessionId])

  const items = useMemo(() => timelineItemsForSession(state, sessionId), [state, sessionId])
  const sessionMatches = Boolean(sessionId && state.sessionId === sessionId)
  return useMemo(() => ({
    sessionId,
    items,
    lastEventId: sessionMatches ? state.lastEventId : null,
    lifecycleRevision: sessionMatches ? state.lifecycleRevision : 0,
    connection: sessionMatches ? state.connection : 'idle',
    restoring: sessionMatches ? restoring : Boolean(sessionId),
    error: sessionMatches ? error : null,
  }), [sessionId, items, sessionMatches, state.lastEventId, state.connection, restoring, error])
}
