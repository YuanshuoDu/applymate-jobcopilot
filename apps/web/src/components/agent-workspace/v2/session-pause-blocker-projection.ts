import {
  AGENT_STREAM_SCHEMA_VERSION,
  SessionControlEventPayloadSchema,
  validate,
} from '@jobcopilot/agent-protocol'

import type { TimelineEvent } from './timeline-reducer'

export type SessionPauseBlockerReason = 'step' | 'external_operation' | 'child_task' | 'recovery'
export type SessionPauseBlocker = Readonly<{
  turnId: string
  reasons: readonly SessionPauseBlockerReason[]
}>

type OrderedEvent = Readonly<{ event: TimelineEvent; sequence: bigint }>
type ControlEventType = 'session.pause_requested' | 'session.resume_requested'
type TransitionEventType = 'session.pause_blocked' | 'session.paused'

const CONTROL_TYPES = new Set<string>(['session.pause_requested', 'session.resume_requested'])
const TRANSITION_TYPES = new Set<string>(['session.pause_blocked', 'session.paused'])
const REASON_ORDER: readonly SessionPauseBlockerReason[] = ['step', 'external_operation', 'child_task', 'recovery']
const PUBLIC_EVENT_ID = /^evt_[a-f0-9]{64}$/
const SUBAGENT_TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REDACTED_TASK_ID_SUFFIX = /^(?:[0-9a-f-]|\[REDACTED_PHONE\])+$/
const MAX_BLOCKERS = 64

export function projectSessionPauseBlocker(
  events: readonly TimelineEvent[],
  sessionId: string | null,
  activeTurnId: string | null = null,
): SessionPauseBlocker | null {
  if (!validId(sessionId) || activeTurnId !== null && !validId(activeTurnId)) return null
  const ordered = orderedSessionEvents(events, sessionId)
  if (!ordered) return null
  const controls = ordered.filter(({ event }) => CONTROL_TYPES.has(event.type))
  if (!controls.every(({ event }) => validControlEvent(event))) return null
  const latestControl = controls.at(-1)?.event
  if (!latestControl || latestControl.type !== 'session.pause_requested'
    || activeTurnId !== null && latestControl.turnId !== activeTurnId) return null

  const currentTurnId = latestControl.turnId
  const requestSequence = BigInt(latestControl.sequence!)
  const followups = ordered.filter(({ event, sequence }) => event.turnId === currentTurnId
    && sequence > requestSequence && TRANSITION_TYPES.has(event.type))
  if (!followups.length) return null
  if (!followups.every(({ event }) => validTransitionEvent(event, latestControl))) return null
  if (followups.some(({ event }) => event.type === 'session.paused')) return null
  const latestTransition = followups.at(-1)!.event

  const reasons = parseBlockerReasons(latestTransition.payload, currentTurnId)
  return reasons ? { turnId: currentTurnId, reasons } : null
}

function orderedSessionEvents(events: readonly TimelineEvent[], sessionId: string): OrderedEvent[] | null {
  const byId = new Map<string, TimelineEvent>()
  for (const event of events) {
    if (event.sessionId !== sessionId || !CONTROL_TYPES.has(event.type) && !TRANSITION_TYPES.has(event.type)) continue
    if (!validEnvelope(event)) return null
    const existing = byId.get(event.id)
    if (existing) {
      if (!sameEvent(existing, event)) return null
      continue
    }
    byId.set(event.id, event)
  }
  const ordered = [...byId.values()].map(event => ({ event, sequence: BigInt(event.sequence!) }))
    .sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.event.id.localeCompare(right.event.id))
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.sequence === ordered[index]!.sequence) return null
  }
  return ordered
}

function validEnvelope(event: TimelineEvent): boolean {
  return event.schemaVersion === AGENT_STREAM_SCHEMA_VERSION && PUBLIC_EVENT_ID.test(event.id) && validId(event.turnId)
    && event.kind === undefined && event.baseRevision === undefined && event.revision === undefined
    && event.sequence !== null && /^(0|[1-9]\d{0,38})$/.test(event.sequence)
}

function validControlEvent(event: TimelineEvent): event is TimelineEvent & { type: ControlEventType } {
  return event.actor === 'user' && event.itemId === null && event.taskId === null
    && validate(SessionControlEventPayloadSchema, event.payload)
    && isRecord(event.payload) && event.payload.turnId === event.turnId
}

function validTransitionEvent(event: TimelineEvent, request: TimelineEvent): event is TimelineEvent & { type: TransitionEventType } {
  if (event.actor !== 'orchestrator' || event.itemId !== null
    || event.taskId !== null && event.taskId !== `root-${event.turnId}`
    || event.causationId !== request.id || !PUBLIC_EVENT_ID.test(event.causationId ?? '')) return false
  if (!isRecord(event.payload)) return false
  if (event.type === 'session.paused') return exactKeys(event.payload, ['pauseRequestEventId', 'turnId'])
    && validId(event.payload.pauseRequestEventId) && event.payload.turnId === event.turnId
  return exactKeys(event.payload, ['pauseRequestEventId', 'blockers'])
    && parseBlockerReasons(event.payload, event.turnId) !== null
}

function parseBlockerReasons(payload: unknown, turnId: string): readonly SessionPauseBlockerReason[] | null {
  if (!isRecord(payload) || !exactKeys(payload, ['pauseRequestEventId', 'blockers']) || !validId(payload.pauseRequestEventId)
    || !Array.isArray(payload.blockers) || payload.blockers.length === 0 || payload.blockers.length > MAX_BLOCKERS) return null
  const blockers = payload.blockers
  if (!blockers.every((blocker): blocker is string => typeof blocker === 'string' && blocker.length > 0 && blocker.length <= 512)) return null
  const reasons = new Set<SessionPauseBlockerReason>()
  for (const blocker of blockers) {
    const reason = blockerReason(blocker, turnId)
    if (!reason) return null
    reasons.add(reason)
  }
  return REASON_ORDER.filter(reason => reasons.has(reason))
}

function blockerReason(blocker: string, turnId: string): SessionPauseBlockerReason | null {
  if (blocker === 'streaming_step') return 'step'
  if (blocker === 'started_external_call') return 'external_operation'
  if (blocker === 'turn_not_quiescent' || blocker === 'turn_state_unknown' || blocker === 'turn_recovery_conflict') return 'recovery'
  for (const prefix of ['task_interrupt_requested:', 'task_state_unknown:', 'task_not_quiescent:', 'task_recovery_conflict:']) {
    if (!blocker.startsWith(prefix)) continue
    const taskId = blocker.slice(prefix.length)
    if (!validTaskId(taskId, turnId)) return null
    return (prefix === 'task_interrupt_requested:' || prefix === 'task_not_quiescent:') && taskId.startsWith('subagent-')
      ? 'child_task' : 'recovery'
  }
  return null
}

function validTaskId(value: string, turnId: string): boolean {
  if (value === `root-${turnId}` || SUBAGENT_TASK_ID.test(value)) return true
  const match = /^(root|subagent)-(.+)$/.exec(value)
  if (!match || match[2]!.length > 128 || !REDACTED_TASK_ID_SUFFIX.test(match[2]!)) return false
  const markers = match[2]!.match(/\[REDACTED_PHONE\]/g)?.length ?? 0
  return markers > 0 && markers <= 5
}

function sameEvent(left: TimelineEvent, right: TimelineEvent): boolean {
  return left.schemaVersion === right.schemaVersion && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.itemId === right.itemId && left.taskId === right.taskId && left.type === right.type && left.actor === right.actor
    && left.sequence === right.sequence && left.causationId === right.causationId && JSON.stringify(left.payload) === JSON.stringify(right.payload)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
