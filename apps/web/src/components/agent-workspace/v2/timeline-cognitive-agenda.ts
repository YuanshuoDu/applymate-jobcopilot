import { isAfter } from './timeline-reducer-utils'
import { parseCognitiveAgendaReceipt, type CognitiveAgendaScope, type CognitiveAgendaView } from './cognitive-agenda-view'
import type { TimelineEvent } from './timeline-reducer'

const MAX_SCOPED_AGENDAS = 16
const SAFE_SEQUENCE = /^(0|[1-9]\d*)$/

export interface TimelineCognitiveAgendaEntry {
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly latest: CognitiveAgendaView
  readonly sequence: string
  readonly eventId: string
}

export interface TimelineCognitiveAgendaState {
  readonly sessionId: string
  readonly latest: CognitiveAgendaView | null
  readonly sequence: string | null
  readonly eventId: string | null
  readonly scoped: readonly TimelineCognitiveAgendaEntry[]
}

export function createCognitiveAgendaState(sessionId: string): TimelineCognitiveAgendaState {
  return { sessionId, latest: null, sequence: null, eventId: null, scoped: [] }
}

/** Folds replay/live receipts while retaining a bounded latest view for each task scope. */
export function reduceCognitiveAgenda(state: TimelineCognitiveAgendaState, event: TimelineEvent): TimelineCognitiveAgendaState {
  if (event.type !== 'cognitive.agenda' || event.actor !== 'orchestrator' && event.actor !== 'subagent' || event.sessionId !== state.sessionId || event.itemId !== null || !event.sequence || !SAFE_SEQUENCE.test(event.sequence) || event.sequence.length > 39) return state
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
  if (!view) return state
  const existing = state.scoped.find(entry => entry.turnId === view.turnId && entry.taskId === view.taskId)
  if (existing && !isAfter(event.sequence, existing.sequence)) return state
  const entry: TimelineCognitiveAgendaEntry = { sessionId: state.sessionId, turnId: view.turnId, taskId: view.taskId, latest: view, sequence: event.sequence, eventId: event.id }
  const scoped = [...state.scoped.filter(item => item !== existing), entry]
    .sort((left, right) => compareSequences(right.sequence, left.sequence))
    .slice(0, MAX_SCOPED_AGENDAS)
  const isLatest = state.sequence === null || isAfter(event.sequence, state.sequence)
  return {
    sessionId: state.sessionId,
    latest: isLatest ? view : state.latest,
    sequence: isLatest ? event.sequence : state.sequence,
    eventId: isLatest ? event.id : state.eventId,
    scoped,
  }
}

function compareSequences(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}
