/** CANONICAL Phase 9 timeline state root — do not duplicate. See #459. */

import { normalizeTimelineEvent, type TimelineAction } from './timeline-reducer'

interface TimelinePageResponse {
  items?: unknown[]
  page?: { hasMore?: boolean; nextCursor?: string | null }
}

export interface TimelineStreamClientOptions {
  sessionId: string
  dispatch: (action: TimelineAction) => void
  signal?: AbortSignal
  fetcher?: typeof fetch
  retryDelayMs?: number
  pageSize?: number
  onConnected?: () => void
  onLegacyEvents?: (events: unknown[]) => void
}

const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_PAGE_SIZE = 100

/** Hydrates the canonical item projection before a live stream is attached. */
export async function hydrateTimeline(options: Pick<TimelineStreamClientOptions, 'sessionId' | 'dispatch' | 'signal' | 'fetcher' | 'pageSize'>): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const items: unknown[] = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ limit: String(options.pageSize ?? DEFAULT_PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(options.sessionId)}/timeline?${query}`, { signal: options.signal })
    if (!response.ok) throw new Error(`Timeline restore failed (${response.status})`)
    const page = await response.json() as TimelinePageResponse
    if (Array.isArray(page.items)) items.push(...page.items)
    cursor = page.page?.hasMore === true && typeof page.page.nextCursor === 'string' ? page.page.nextCursor : null
  } while (cursor && !options.signal?.aborted)
  options.dispatch({ type: 'hydrate', items })
}

/** Attaches one reconnecting V2 SSE consumer to the same reducer used by replay. */
export async function streamAgentTimeline(options: TimelineStreamClientOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let afterSequence = BigInt(0)
  let selectedV2 = false
  let connected = false

  await hydrateTimeline(options)

  while (!options.signal?.aborted) {
    const path = `/api/agent/sessions/${encodeURIComponent(options.sessionId)}/events`
    const url = selectedV2 ? `${path}?afterSequence=${afterSequence.toString()}` : path
    let response: Response
    try {
      response = await fetcher(url, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted || isAbort(error)) return
      connected = false
      options.dispatch({ type: 'disconnected' })
      await delay(retryDelayMs, options.signal)
      continue
    }
    if (!response.ok) throw new Error(`Session stream failed (${response.status})`)
    if (!isEventStream(response)) {
      if (selectedV2) throw new Error('Session stream protocol changed during reconnect')
      if (!connected) {
        connected = true
        options.dispatch({ type: 'connected' })
        options.onConnected?.()
      }
      const body = await response.json() as { events?: unknown[] }
      const events = Array.isArray(body.events) ? body.events : []
      for (const event of events) {
        options.dispatch({ type: 'legacy', event })
      }
      options.onLegacyEvents?.(events)
      return
    }
    selectedV2 = true
    if (!connected) {
      connected = true
      options.dispatch({ type: 'connected' })
      options.onConnected?.()
    }
    if (!response.body) throw new Error('Session event stream has no body')

    let ended = false
    let snapshotRequired = false
    try {
      await readSseBody(response.body, frame => {
        const event = normalizeTimelineEvent(frame.data)
        if (!event || event.sessionId !== options.sessionId) return
        if (event.sequence !== null) {
          const sequence = BigInt(event.sequence)
          if (sequence <= afterSequence) return
          afterSequence = sequence
        }
        if (event.type === 'stream.overflow') {
          snapshotRequired = true
          options.dispatch({ type: 'snapshot-required' })
        } else {
          options.dispatch(event.kind ? { type: 'delta', delta: event } : { type: 'event', event })
        }
      }, options.signal)
    } finally {
      ended = true
    }
    if (snapshotRequired && !options.signal?.aborted) await hydrateTimeline(options)
    if (ended && !options.signal?.aborted) {
      connected = false
      options.dispatch({ type: 'disconnected' })
      await delay(retryDelayMs, options.signal)
    }
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true
}

interface SseFrame { event: string; id: string | null; data: unknown }

async function readSseBody(body: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let id: string | null = null
  let data: string[] = []
  const flush = () => {
    if (!data.length) return
    try { onFrame({ event, id, data: JSON.parse(data.join('\n')) as unknown }) } catch { /* Malformed frames are ignored. */ }
    event = ''
    id = null
    data = []
  }
  const process = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line) return flush()
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(process)
    }
    buffer += decoder.decode()
    if (buffer) process(buffer)
    flush()
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function isAbort(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
