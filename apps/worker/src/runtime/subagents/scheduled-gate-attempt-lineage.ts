import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

type LifecycleEvent = Readonly<Record<string, unknown> & { type: string; nodeKey: string; idempotencyKey: string; expectedRevision: number }>
export type ScheduledGateAttemptLineageInput = Readonly<{
  rootTaskId: string
  gateTaskId: string
  maxAttempts: number
  requestAttemptCount: number
  currentAttemptCount: number
  currentStatus: string
  events: readonly unknown[]
}>

/** Validates that a Gate wait follows its exact answer handoff and only bounded worker retry hops. */
export function scheduledGateAttemptLineageMatches(input: ScheduledGateAttemptLineageInput): boolean {
  const { rootTaskId, gateTaskId, maxAttempts, requestAttemptCount: request, currentAttemptCount: current, currentStatus, events } = input
  if (!validId(rootTaskId) || !validId(gateTaskId) || !positive(maxAttempts) || !nonnegative(request)
    || !nonnegative(current) || request > maxAttempts + 50 || current > maxAttempts + 51 || !Array.isArray(events)) return false
  const relevant = events.filter(value => record(value)?.nodeKey === "gate" && ["task.started", "task.retrying",
    "task.waiting_for_user", "task.gate_choice_resumed"].includes(String(record(value)?.type)))
  if (relevant.filter(value => record(value)?.type === "task.waiting_for_user").length > 51
    || relevant.filter(value => record(value)?.type === "task.gate_choice_resumed").length > 51) return false
  const used = new Set<LifecycleEvent>()
  const find = (type: string, attempt: number): LifecycleEvent | null => {
    const key = taskGraphLifecycleKey(rootTaskId, "gate", attempt, type)
    const matches = relevant.filter(value => record(value)?.idempotencyKey === key)
    if (matches.length !== 1) return null
    const event = parseEvent(matches[0])
    if (!event || event.type !== type || event.nodeKey !== "gate" || event.idempotencyKey !== key) return null
    used.add(event)
    return event
  }
  const start = (attempt: number) => find("task.started", attempt)
  const retry = (attempt: number) => find("task.retrying", attempt)
  const waiting = (attempt: number) => find("task.waiting_for_user", attempt)
  const resume = (attempt: number) => {
    const event = find("task.gate_choice_resumed", attempt)
    return event && event.gateTaskId === gateTaskId && event.requestAttemptCount === attempt
      && event.resumedAttemptCount === attempt + 1 ? event : null
  }
  const chain: LifecycleEvent[] = []
  if (current > 0) {
    for (let attempt = 1; attempt <= current; attempt += 1) {
      const event = start(attempt)
      if (!event) return false
      chain.push(event)
      if (attempt === current) break
      let transition: LifecycleEvent | null = null
      if (attempt === request || (attempt < request && waiting(attempt))) {
        const question = attempt === request ? waiting(attempt) : waiting(attempt)
        transition = resume(attempt)
        if (!question || !transition) return false
        chain.push(question)
      } else if (attempt > request) transition = retry(attempt)
      else {
        const retryEvent = retry(attempt), question = waiting(attempt), resumeEvent = resume(attempt)
        if (Boolean(retryEvent) === Boolean(question && resumeEvent)) return false
        transition = retryEvent ?? (question && resumeEvent ? resumeEvent : null)
        if (question && resumeEvent) chain.push(question)
      }
      if (!transition || attempt >= maxAttempts && transition.type !== "task.gate_choice_resumed") return false
      chain.push(transition)
    }
  } else if (request !== 0 || currentStatus !== "queued") return false

  if (request > 0) {
    if (current < request || !waiting(request) || !resume(request)) return false
  } else if (relevant.some(value => record(value)?.type === "task.gate_choice_resumed")) return false

  if (currentStatus === "queued" && current > 0) {
    if (request > 0 && current === request) {
      const question = waiting(current), event = resume(current)
      if (!question || !event) return false
      chain.push(question, event)
    } else {
      const event = retry(current)
      if (!event || current >= maxAttempts) return false
      chain.push(event)
    }
  } else if (currentStatus === "waiting_for_user") {
    const event = waiting(current)
    if (!event) return false
    chain.push(event)
  } else if (currentStatus !== "queued" && current === 0) return false

  if (used.size !== relevant.length) return false
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index]!.expectedRevision !== chain[index - 1]!.expectedRevision + 1) return false
  }
  return true
}

function parseEvent(value: unknown): LifecycleEvent | null {
  const row = record(value)
  if (!row || typeof row.type !== "string" || typeof row.nodeKey !== "string" || typeof row.idempotencyKey !== "string"
    || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 0) return null
  const keys = row.type === "task.gate_choice_resumed"
    ? ["expectedRevision", "gateTaskId", "idempotencyKey", "nodeKey", "requestAttemptCount", "resumedAttemptCount", "type"]
    : ["expectedRevision", "idempotencyKey", "nodeKey", "type"]
  if (!exact(row, keys)) return null
  return row as LifecycleEvent
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null }
  catch { return null }
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
