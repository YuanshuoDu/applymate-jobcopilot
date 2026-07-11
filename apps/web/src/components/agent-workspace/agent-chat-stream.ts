export interface AgentChatAction {
  type: string
  [key: string]: unknown
}

interface StreamAgentChatOptions {
  sessionId: string | null
  messages: Array<{ role: 'user'; content: string }>
  model: string
  onSession: (sessionId: string) => void
  onBlock: (type: string, data: unknown) => void
  onAction: (action: AgentChatAction) => void
}

export async function streamAgentChat({
  sessionId,
  messages,
  model,
  onSession,
  onBlock,
  onAction,
}: StreamAgentChatOptions) {
  const res = await fetch('/api/agent/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId ?? undefined,
      messages,
      model,
    }),
  })
  if (!res.ok || !res.body) {
    throw new Error(await readableResponseError(res))
  }
  return readAgentChatStream(res.body, { onSession, onBlock, onAction })
}

export async function readAgentChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: Pick<StreamAgentChatOptions, 'onSession' | 'onBlock' | 'onAction'>,
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  let event = ''
  const processLine = (line: string) => {
    if (line.startsWith('event: ')) {
      event = line.slice(7).trim()
      return
    }
    if (!line.startsWith('data: ')) return

    let streamError: string | null = null
    try {
      const d = JSON.parse(line.slice(6))
      if (event === 'session' && typeof d.sessionId === 'string') {
        handlers.onSession(d.sessionId)
      } else if (event === 'text' && d.delta) {
        full += d.delta
      } else if (event === 'block' && typeof d.type === 'string') {
        handlers.onBlock(d.type, d)
      } else if (event === 'action' && typeof d.type === 'string') {
        handlers.onAction(d)
      } else if (event === 'error') {
        streamError = typeof d.message === 'string' ? d.message : 'Agent chat failed.'
      }
    } catch { }
    event = ''
    if (streamError) throw new Error(streamError)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      processLine(line)
    }
  }
  buf += decoder.decode()
  if (buf.trim()) processLine(buf)
  return displayTextFromAgentStream(full)
}

export function displayTextFromAgentStream(text: string) {
  return text.replace(/^ACTION:.+$/gm, '').trim()
}

export async function readableResponseError(res: Response) {
  const fallback = `Agent chat failed (${res.status})`
  const raw = await res.text().catch(() => '')
  if (!raw.trim()) return fallback
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.message
    return typeof message === 'string' && message.trim() ? message : fallback
  } catch {
    return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw
  }
}
