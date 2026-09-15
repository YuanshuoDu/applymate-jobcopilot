import { isAfter } from './timeline-reducer-utils'
import { parseCognitiveAgendaReceipt, type CognitiveAgendaScope, type CognitiveAgendaView } from './cognitive-agenda-view'
import type { TimelineEvent } from './timeline-reducer'

export interface TimelineCognitiveAgendaState {
  readonly sessionId: string
  readonly latest: CognitiveAgendaView | null
  readonly sequence: string | null
  readonly eventId: string | null
}

export function createCognitiveAgendaState(sessionId: string): TimelineCognitiveAgendaState {
  return { sessionId, latest: null, sequence: null, eventId: null }
}

/** Folds replay/live receipts by sequence while rejecting malformed or foreign scope. */
export function reduceCognitiveAgenda(state: TimelineCognitiveAgendaState, event: TimelineEvent): TimelineCognitiveAgendaState {
  if (event.type !== 'cognitive.agenda' || event.sessionId !== state.sessionId || event.itemId !== null || !event.sequence || (state.sequence !== null && !isAfter(event.sequence, state.sequence))) return state
  const payload = event.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return state
  const raw = payload as Record<string, unknown>
  const scope: CognitiveAgendaScope = {
    sessionId: event.sessionId,
    turnId: event.turnId,
    taskId: event.taskId ?? '',
    stepId: typeof raw.stepId === 'string' ? raw.stepId : '',
  }
  const view = parseCognitiveAgendaReceipt(payload, scope)
  return view ? { sessionId: state.sessionId, latest: view, sequence: event.sequence, eventId: event.id } : state
}
