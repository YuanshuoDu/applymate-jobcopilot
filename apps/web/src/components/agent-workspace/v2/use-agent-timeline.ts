'use client'

import { useEffect, useMemo, useState } from 'react'

import { streamAgentTimeline } from './stream-client'
import type { CognitiveAgendaView } from './cognitive-agenda-view'
import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineConnection, type TimelineItem, type TimelineState } from './timeline-reducer'
import { selectPlanLedgerProjection, type PlanLedgerProjection } from './plan-ledger-view'
import type { TimelineCognitiveAgendaEntry } from './timeline-cognitive-agenda'
import type { TimelineSteeringMarkerState } from './timeline-steering-markers'
import type { TimelineSessionControlGate } from './timeline-session-control'

export type AgentCognitiveAgendaSnapshot = CognitiveAgendaView & {
  readonly steeringMarkers?: TimelineSteeringMarkerState
}

export interface AgentTimelineSnapshot {
  readonly sessionId: string | null
  readonly items: readonly TimelineItem[]
  readonly lastEventId: string | null
  readonly lifecycleRevision: number
  readonly controlGate: TimelineSessionControlGate
  readonly controlRevision: number
  readonly pausedAt: string | null
  readonly cognitiveAgenda: AgentCognitiveAgendaSnapshot | null
  readonly cognitiveAgendas: readonly TimelineCognitiveAgendaEntry[]
  readonly planLedger: PlanLedgerProjection
  readonly steeringMarkers?: TimelineSteeringMarkerState
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
  const cognitiveAgenda = sessionMatches && state.cognitiveAgenda.latest
    ? { ...state.cognitiveAgenda.latest, steeringMarkers: state.steeringMarkers }
    : null
  return useMemo(() => ({
    sessionId,
    items,
    lastEventId: sessionMatches ? state.lastEventId : null,
    lifecycleRevision: sessionMatches ? state.lifecycleRevision : 0,
    controlGate: sessionMatches ? state.sessionControl.controlGate : 'open',
    controlRevision: sessionMatches ? state.sessionControl.controlRevision : 0,
    pausedAt: sessionMatches ? state.sessionControl.pausedAt : null,
    cognitiveAgenda,
    cognitiveAgendas: sessionMatches ? state.cognitiveAgenda.scoped : [],
    planLedger: sessionMatches ? selectPlanLedgerProjection(state.planLedger) : { sessionId: sessionId ?? 'draft', plans: [], currentPlan: null },
    steeringMarkers: sessionMatches ? state.steeringMarkers : { observed: [], applied: [], active: [], observedCount: 0, appliedCount: 0, activeCount: 0 },
    connection: sessionMatches ? state.connection : 'idle',
    restoring: sessionMatches ? restoring : Boolean(sessionId),
    error: sessionMatches ? error : null,
  }), [sessionId, items, sessionMatches, state.lastEventId, state.sessionControl.controlGate, state.sessionControl.controlRevision, state.sessionControl.pausedAt, state.connection, state.steeringMarkers, state.cognitiveAgenda.scoped, state.planLedger, cognitiveAgenda, restoring, error])
}
