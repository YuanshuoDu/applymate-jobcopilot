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

export function filterQuestionHydrationValues(values: readonly unknown[], sessionId: string): unknown[] {
  return values.filter(value => belongsToSession(value, sessionId))
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
