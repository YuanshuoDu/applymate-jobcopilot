import { normalizeTimelineEvent } from './timeline-reducer'

export interface QuestionHydrationPumpOptions {
  sessionId: string
  signal?: AbortSignal
  hydrate: (itemIds: readonly string[]) => Promise<void>
}

export interface QuestionHydrationPump {
  request(value: unknown): void
  pump(): void
  current(): Promise<void> | null
}

export interface FinalItemHydrationPumpOptions {
  sessionId: string
  signal?: AbortSignal
  hydrate: (itemId: string) => Promise<void>
}

export interface FinalItemHydrationPump {
  request(value: unknown): void
  pump(): void
  current(): Promise<void> | null
}

const FINAL_ITEM_RETRY_DELAYS_MS = [250, 1_000] as const

/** Queues strict live question stubs behind one targeted canonical snapshot request. */
export function createQuestionHydrationPump(options: QuestionHydrationPumpOptions): QuestionHydrationPump {
  let current: Promise<void> | null = null
  let scheduled = false
  const pending = new Set<string>()

  const pump = (): void => {
    if (scheduled || current || pending.size === 0 || options.signal?.aborted) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (current || pending.size === 0 || options.signal?.aborted) return
      const batch = new Set(pending)
      pending.clear()
      let failed = false
      current = (async () => {
        try {
          await options.hydrate([...batch].map(itemIdFromKey))
        } catch {
          failed = true
          for (const key of batch) pending.add(key)
        } finally {
          current = null
          if (!failed) pump()
        }
      })()
    })
  }

  return {
    request(value: unknown): void {
      const key = questionStubKey(value, options.sessionId)
      if (!key) return
      pending.add(key)
      pump()
    },
    pump,
    current: () => current,
  }
}

/** Hydrates one canonical final item for each owned, same-session completion event. */
export function createFinalItemHydrationPump(options: FinalItemHydrationPumpOptions): FinalItemHydrationPump {
  let current: Promise<void> | null = null
  let scheduled = false
  const pending = new Set<string>()
  const hydrating = new Set<string>()
  const hydrated = new Set<string>()
  const exhausted = new Set<string>()
  const attempts = new Map<string, number>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const cancelRetries = (): void => {
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
    pending.clear()
    attempts.clear()
  }
  options.signal?.addEventListener('abort', cancelRetries, { once: true })

  const retry = (itemId: string): void => {
    if (options.signal?.aborted) {
      attempts.delete(itemId)
      return
    }
    const attempt = attempts.get(itemId) ?? 0
    const delay = FINAL_ITEM_RETRY_DELAYS_MS[attempt - 1]
    if (delay === undefined) {
      attempts.delete(itemId)
      exhausted.add(itemId)
      return
    }
    const timer = setTimeout(() => {
      retryTimers.delete(itemId)
      if (options.signal?.aborted) {
        attempts.delete(itemId)
        exhausted.add(itemId)
        return
      }
      pending.add(itemId)
      pump()
    }, delay)
    retryTimers.set(itemId, timer)
  }

  const pump = (): void => {
    if (scheduled || current || pending.size === 0 || options.signal?.aborted) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (current || pending.size === 0 || options.signal?.aborted) return
      const batch = [...pending]
      pending.clear()
      batch.forEach(itemId => hydrating.add(itemId))
      current = (async () => {
        await Promise.all(batch.map(async itemId => {
          attempts.set(itemId, (attempts.get(itemId) ?? 0) + 1)
          try {
            await options.hydrate(itemId)
            if (!options.signal?.aborted) hydrated.add(itemId)
          } catch {
            retry(itemId)
          } finally {
            hydrating.delete(itemId)
            if (hydrated.has(itemId)) attempts.delete(itemId)
          }
        }))
        current = null
        pump()
      })()
    })
  }

  return {
    request(value: unknown): void {
      const itemId = finalItemIdFromCompletion(value, options.sessionId)
      if (!itemId || options.signal?.aborted || hydrated.has(itemId) || exhausted.has(itemId) ||
        hydrating.has(itemId) || retryTimers.has(itemId)) return
      pending.add(itemId)
      pump()
    },
    pump,
    current: () => current,
  }
}

export function filterQuestionHydrationValues(values: readonly unknown[], sessionId: string): unknown[] {
  return values.filter(value => belongsToSession(value, sessionId))
}

function finalItemIdFromCompletion(value: unknown, sessionId: string): string | null {
  const event = normalizeTimelineEvent(value)
  if (!event || event.type !== 'turn.completed' || event.actor !== 'orchestrator' || event.sessionId !== sessionId ||
    !safeId(event.id) || !safeId(event.turnId) || !safeId(event.itemId) || !isRecord(event.payload)) return null
  const finalItemId = event.payload.finalItemId
  return safeId(finalItemId) && finalItemId === event.itemId ? finalItemId : null
}

function questionStubKey(value: unknown, sessionId: string): string | null {
  const event = normalizeTimelineEvent(value)
  if (!event || event.type !== 'item.started' || event.actor !== 'orchestrator' || event.sessionId !== sessionId ||
    !safeId(event.id) || !safeId(event.turnId) || !safeId(event.itemId) ||
    (event.taskId !== null && !safeId(event.taskId)) || event.sequence === null || !isRecord(event.payload)) return null
  const payload = event.payload
  if (!exact(payload, ['itemId', 'waitKind', 'questionId', 'toolCallId']) || payload.itemId !== event.itemId ||
    payload.waitKind !== 'question' || !safeId(payload.questionId) ||
    (payload.toolCallId !== null && !safeId(payload.toolCallId))) return null
  return `${event.itemId}\u0000${payload.questionId}`
}

function itemIdFromKey(value: string): string {
  const separator = value.indexOf('\u0000')
  return separator === -1 ? value : value.slice(0, separator)
}

function belongsToSession(value: unknown, sessionId: string): boolean {
  if (!isRecord(value) || value.sessionId === undefined) return true
  return value.sessionId === sessionId
}

function exact(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key))
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
