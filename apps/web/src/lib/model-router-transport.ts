import Anthropic from '@anthropic-ai/sdk'
import { pinnedFetch } from '@jobcopilot/shared/pinned-outbound'
import { isSafeAiEndpoint } from '@jobcopilot/shared/safe-ai-endpoint'
import type { AiConfig, ChatMessage, ChatResult, MiniMaxThinkingMode, Provider } from './model-router-catalogue'

export type StreamUsage = { inputTokens?: number; outputTokens?: number }
type ResolvedConfig = AiConfig & { resolvedKey: string; apiBase?: string }
type RequestConfig = { base: string; provider: Provider; model: string; key: string; messages: ChatMessage[];
  maxTokens: number; stream: boolean; thinking?: MiniMaxThinkingMode }
type RequestLifecycle = { cleanup?: () => void }

function splitSystemMessages(messages: ChatMessage[]) {
  const systemMsg = messages.find(message => message.role === 'system')
  const chatMsgs = messages.filter(message => message.role !== 'system') as { role: 'user' | 'assistant'; content: string }[]
  return { systemMsg, chatMsgs }
}

export async function callAnthropic(messages: ChatMessage[], config: AiConfig & { resolvedKey: string }, maxTokens: number,
  options?: { signal?: AbortSignal; maxRetries?: number }): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: config.resolvedKey,
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}) })
  const { systemMsg, chatMsgs } = splitSystemMessages(messages)
  const response = await client.messages.create({ model: config.model, max_tokens: maxTokens,
    ...(systemMsg ? { system: systemMsg.content } : {}), messages: chatMsgs },
  options?.signal ? { signal: options.signal } : undefined)
  return { text: response.content[0].type === 'text' ? response.content[0].text : '',
    inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, provider: 'anthropic', model: config.model }
}

export async function* streamAnthropic(messages: ChatMessage[], config: AiConfig & { resolvedKey: string }, maxTokens: number,
  usage: StreamUsage): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: config.resolvedKey })
  const { systemMsg, chatMsgs } = splitSystemMessages(messages)
  const stream = await client.messages.create({ model: config.model, max_tokens: maxTokens,
    ...(systemMsg ? { system: systemMsg.content } : {}), messages: chatMsgs, stream: true })
  for await (const chunk of stream) {
    if (chunk.type === 'message_start') usage.inputTokens = chunk.message.usage.input_tokens
    if (chunk.type === 'message_delta') usage.outputTokens = chunk.usage.output_tokens
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') yield chunk.delta.text
  }
}

function oaiFetch(config: RequestConfig, signal?: AbortSignal, lifecycle?: RequestLifecycle): Promise<Response> {
  if (config.provider === 'custom' && !isSafeAiEndpoint(config.base, { allowLocalDevelopment: process.env.NODE_ENV !== 'production' })) {
    return Promise.reject(new Error('Custom AI endpoint is not an allowed public HTTPS destination'))
  }
  const controller = new AbortController(), relayAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) relayAbort()
  else signal?.addEventListener('abort', relayAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 120_000)
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', relayAbort) }
  const providerOptions = config.provider === 'minimax'
    ? { max_completion_tokens: config.maxTokens, reasoning_split: true,
        ...(config.model === 'MiniMax-M3' ? { thinking: { type: config.thinking ?? 'adaptive' } } : {}),
        ...(config.stream ? { stream_options: { include_usage: true } } : {}) }
    : { max_tokens: config.maxTokens, ...(config.stream ? { stream_options: { include_usage: true } } : {}) }
  const response = pinnedFetch(`${config.base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
    body: JSON.stringify({ model: config.model, ...providerOptions, messages: config.messages, stream: config.stream }),
    redirect: 'error', signal: controller.signal,
    allowLocalDevelopment: config.provider === 'custom' && process.env.NODE_ENV !== 'production',
  })
  if (lifecycle) { lifecycle.cleanup = cleanup; return response }
  return response.finally(cleanup)
}

async function readOpenAICompatResponse(response: Response, config: ResolvedConfig): Promise<ChatResult> {
  if (!response.ok) throw new Error(`${config.provider} API error ${response.status}`)
  const data: unknown = await response.json()
  const result = data as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const choice = result.choices?.[0], text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  if (!text.trim()) {
    const finish = choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ''
    throw new Error(`${config.provider} returned no final content${finish}`)
  }
  return { text, inputTokens: result.usage?.prompt_tokens, outputTokens: result.usage?.completion_tokens,
    provider: config.provider, model: config.model }
}

function requestConfig(messages: ChatMessage[], config: ResolvedConfig, maxTokens: number, stream: boolean): RequestConfig {
  if (!config.apiBase) throw new Error(`No API base URL for provider "${config.provider}"`)
  return { base: config.apiBase, provider: config.provider, model: config.model, key: config.resolvedKey,
    messages, maxTokens, stream, thinking: config.thinking }
}

export async function callOpenAICompat(messages: ChatMessage[], config: ResolvedConfig, maxTokens: number,
  signal?: AbortSignal): Promise<ChatResult> {
  return readOpenAICompatResponse(await oaiFetch(requestConfig(messages, config, maxTokens, false), signal), config)
}

/** Gate-only request keeps cancellation and timeout active until response.json() consumes the body. */
export async function callReservedOpenAICompat(messages: ChatMessage[], config: ResolvedConfig, maxTokens: number,
  signal?: AbortSignal): Promise<ChatResult> {
  const lifecycle: RequestLifecycle = {}
  try { return await readOpenAICompatResponse(await oaiFetch(requestConfig(messages, config, maxTokens, false), signal, lifecycle), config) }
  finally { lifecycle.cleanup?.() }
}

export async function* streamOpenAICompat(messages: ChatMessage[], config: ResolvedConfig, maxTokens: number,
  usage: StreamUsage): AsyncGenerator<string> {
  const response = await oaiFetch(requestConfig(messages, config, maxTokens, true))
  if (!response.ok) throw new Error(`${config.provider} API error ${response.status}`)
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let lineBuffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') return
        try {
          const json = JSON.parse(payload)
          if (typeof json.usage?.prompt_tokens === 'number') usage.inputTokens = json.usage.prompt_tokens
          if (typeof json.usage?.completion_tokens === 'number') usage.outputTokens = json.usage.completion_tokens
          const delta = json.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally { reader.releaseLock() }
}

export async function* stripThinkStream(source: AsyncGenerator<string>): AsyncGenerator<string> {
  let buffer = '', inThink = false
  for await (const chunk of source) {
    buffer += chunk
    while (true) {
      if (!inThink) {
        const index = buffer.indexOf('<think>')
        if (index === -1) {
          const safe = Math.max(0, buffer.length - 7)
          if (safe > 0) { yield buffer.slice(0, safe); buffer = buffer.slice(safe) }
          break
        }
        if (index > 0) yield buffer.slice(0, index)
        buffer = buffer.slice(index + 7); inThink = true
      } else {
        const index = buffer.indexOf('</think>')
        if (index === -1) { buffer = buffer.length > 8 ? buffer.slice(buffer.length - 8) : buffer; break }
        buffer = buffer.slice(index + 8); inThink = false
      }
    }
  }
  if (!inThink && buffer) yield buffer
}
