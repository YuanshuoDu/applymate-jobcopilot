import { normalizeTimelineEvent } from './timeline-reducer'

export interface QuestionHydrationPumpOptions {
  sessionId: string
  signal?: AbortSignal
  hydrate: (itemIds: readonly string[]) => Promise<void>
  hydrateFinalItem?: (target: FinalItemHydrationTarget) => Promise<void>
}

export interface FinalItemHydrationTarget {
  readonly itemId: string
  readonly turnId: string
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
  let finalOnlyPending = false
  let resumeQuestionsAfterFinalOnly = false
  const pending = new Set<string>()
  const pendingFinal = new Map<string, FinalItemHydrationTarget>()
  const seenFinalItemIds = new Set<string>()

  const hydrateFinalBatch = async (batch: readonly FinalItemHydrationTarget[]): Promise<void> => {
    for (const target of batch) {
      if (options.signal?.aborted) break
      try { await options.hydrateFinalItem?.(target) } catch { /* A final item is scheduled at most once. */ }
    }
  }

  const drainFinalOnly = (): void => {
    if (scheduled || current || pendingFinal.size === 0 || options.signal?.aborted) return
    finalOnlyPending = true
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (current || pendingFinal.size === 0 || options.signal?.aborted) {
        finalOnlyPending = false
        return
      }
      const batch = [...pendingFinal.values()]
      pendingFinal.clear()
      current = (async () => {
        await hydrateFinalBatch(batch)
        current = null
        if (pendingFinal.size > 0) drainFinalOnly()
        else {
          finalOnlyPending = false
          const resumeQuestions = resumeQuestionsAfterFinalOnly && !options.signal?.aborted
          resumeQuestionsAfterFinalOnly = false
          if (resumeQuestions) pump()
        }
      })()
    })
  }

  const pump = (): void => {
    if (scheduled || current || (pending.size === 0 && pendingFinal.size === 0) || options.signal?.aborted) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (current || (pending.size === 0 && pendingFinal.size === 0) || options.signal?.aborted) return
      const batch = new Set(pending)
      pending.clear()
      const finalBatch = [...pendingFinal.values()]
      pendingFinal.clear()
      let failed = false
      current = (async () => {
        if (batch.size > 0) {
          try {
            await options.hydrate([...batch].map(itemIdFromKey))
          } catch {
            failed = true
            for (const key of batch) pending.add(key)
          }
        }
        if (finalBatch.length > 0) await hydrateFinalBatch(finalBatch)
        current = null
        if (!failed) pump()
        else if (pendingFinal.size > 0) drainFinalOnly()
      })()
    })
  }

  return {
    request(value: unknown): void {
      const key = questionStubKey(value, options.sessionId)
      let queued = false
      if (key) {
        pending.add(key)
        if (finalOnlyPending) resumeQuestionsAfterFinalOnly = true
        queued = true
      }
      const target = finalItemHydrationTarget(value, options.sessionId)
      if (target && options.hydrateFinalItem && !seenFinalItemIds.has(target.itemId)) {
        seenFinalItemIds.add(target.itemId)
        pendingFinal.set(target.itemId, target)
        queued = true
      }
      if (!queued) return
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

function finalItemHydrationTarget(value: unknown, sessionId: string): FinalItemHydrationTarget | null {
  const event = normalizeTimelineEvent(value)
  if (!event || event.type !== 'turn.completed' || event.actor !== 'orchestrator' || event.sessionId !== sessionId ||
    !safeId(event.turnId) || !safeId(event.itemId) || event.sequence === null || !isRecord(event.payload)) return null
  const payload = event.payload
  if (!safeId(payload.turnId) || payload.turnId !== event.turnId || !safeId(payload.taskId) || payload.taskId !== event.taskId ||
    !safeId(payload.finalItemId) || payload.finalItemId !== event.itemId) return null
  return { itemId: event.itemId, turnId: event.turnId }
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
