import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import type { AgentTranscriptEvent } from './session-view-model'

export interface AgentSessionStreamEnvelope {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: string
  actor: string
  sequence: string | null
  payload: unknown
}

interface SessionStreamOptions {
  sessionId: string
  signal?: AbortSignal
  onEvent: (event: AgentTranscriptEvent) => void
  onConnected?: () => void
  fetcher?: typeof fetch
  retryDelayMs?: number
}

interface SseFrame {
  event: string
  id: string | null
  data: unknown
}

const DEFAULT_RETRY_DELAY_MS = 250

/** Restores either the legacy JSON transcript or the durable V2 SSE stream. */
export async function streamAgentSessionEvents({
  sessionId,
  signal,
  onEvent,
  onConnected,
  fetcher = fetch,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}: SessionStreamOptions): Promise<void> {
  let afterSequence = BigInt(0)
  let v2Selected = false
  const seenEventIds = new Set<string>()

  while (!signal?.aborted) {
    let response: Response
    try {
      response = await fetchSessionEvents(fetcher, sessionId, afterSequence, v2Selected, signal)
    } catch (error) {
      if (signal?.aborted) return
      if (!v2Selected) throw error
      await delay(retryDelayMs, signal)
      if (signal?.aborted) return
      if (error instanceof Error && error.name === 'AbortError') return
      continue
    }

    if (!response.ok) throw new Error(`Session restore failed (${response.status})`)

    if (!isEventStream(response)) {
      if (v2Selected) throw new Error('Session stream protocol changed during restore')
      onConnected?.()
      await readLegacyTranscript(response, onEvent)
      return
    }

    v2Selected = true
    onConnected?.()
    if (!response.body) throw new Error('Session event stream has no body')
    try {
      await readSseBody(response.body, frame => {
        const envelope = asStreamEnvelope(frame.data)
        if (!envelope || envelope.sessionId !== sessionId) return
        const sequence = parseSequence(envelope.sequence)
        if (sequence === null || sequence <= afterSequence) return
        afterSequence = sequence
        if (seenEventIds.has(envelope.id)) return
        seenEventIds.add(envelope.id)
        const transcript = transcriptFromEnvelope(envelope)
        if (transcript) onEvent(transcript)
      }, signal)
    } catch {
      if (signal?.aborted) return
    }

    if (!signal?.aborted) await delay(retryDelayMs, signal)
  }
}

async function fetchSessionEvents(
  fetcher: typeof fetch,
  sessionId: string,
  afterSequence: bigint,
  v2Selected: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const path = `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`
  const url = v2Selected ? `${path}?afterSequence=${afterSequence.toString()}` : path
  return fetcher(url, { signal })
}

function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true
}

async function readLegacyTranscript(response: Response, onEvent: SessionStreamOptions['onEvent']): Promise<void> {
  const payload = await response.json() as { events?: unknown }
  if (!Array.isArray(payload.events)) return
  for (const event of payload.events) {
    const transcript = asTranscriptEvent(event)
    if (transcript) onEvent(transcript)
  }
}

async function readSseBody(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let id: string | null = null
  let data: string[] = []

  const flush = () => {
    if (data.length === 0) return
    try { onFrame({ event, id, data: JSON.parse(data.join('\n')) as unknown }) } catch { /* Ignore malformed frames. */ }
    event = ''
    id = null
    data = []
  }
  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') { flush(); return }
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
      lines.forEach(processLine)
    }
    buffer += decoder.decode()
    if (buffer) processLine(buffer)
    flush()
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function asStreamEnvelope(value: unknown): AgentSessionStreamEnvelope | null {
  if (!isRecord(value) || value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' || typeof value.type !== 'string' ||
    (typeof value.sequence !== 'string' && value.sequence !== null)) return null
  return value as unknown as AgentSessionStreamEnvelope
}

function parseSequence(value: string | null): bigint | null {
  if (value === null || !/^\d{1,39}$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}

function transcriptFromEnvelope(envelope: AgentSessionStreamEnvelope): AgentTranscriptEvent | null {
  const payload = isRecord(envelope.payload) ? envelope.payload : null
  const legacy = payload && isRecord(payload.legacy) ? payload.legacy : null
  if (legacy && typeof legacy.type === 'string' && typeof legacy.speaker === 'string' && typeof legacy.body === 'string') {
    return {
      id: envelope.id,
      taskId: typeof envelope.taskId === 'string' ? envelope.taskId : null,
      type: legacy.type,
      speaker: legacy.speaker,
      title: typeof legacy.title === 'string' ? legacy.title : null,
      body: legacy.body,
      data: legacy.data ?? null,
      durationMs: typeof legacy.durationMs === 'number' ? legacy.durationMs : null,
      createdAt: new Date().toISOString(),
    }
  }
  return {
    id: envelope.id,
    taskId: typeof envelope.taskId === 'string' ? envelope.taskId : null,
    type: 'error',
    speaker: 'System',
    title: 'Opaque agent event',
    body: `Preserved an unrecognized agent event: ${envelope.type}`,
    data: { opaque: true, eventType: envelope.type },
    durationMs: null,
    createdAt: new Date().toISOString(),
  }
}

function asTranscriptEvent(value: unknown): AgentTranscriptEvent | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' ||
    typeof value.speaker !== 'string' || typeof value.body !== 'string' || typeof value.createdAt !== 'string') return null
  return {
    id: value.id,
    taskId: typeof value.taskId === 'string' ? value.taskId : null,
    type: value.type,
    speaker: value.speaker,
    title: typeof value.title === 'string' ? value.title : null,
    body: value.body,
    data: value.data ?? null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
    createdAt: value.createdAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return
  await new Promise<void>(resolve => {
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve() }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
