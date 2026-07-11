import { describe, expect, it, vi } from 'vitest'
import { displayTextFromAgentStream, readAgentChatStream, readableResponseError } from './agent-chat-stream'

function streamFrom(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function streamFromChunks(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk))
      controller.close()
    },
  })
}

describe('agent chat stream helpers', () => {
  it('parses session, text, block, and action events', async () => {
    const onSession = vi.fn()
    const onBlock = vi.fn()
    const onAction = vi.fn()

    const text = await readAgentChatStream(streamFrom([
      'event: session',
      'data: {"sessionId":"s1"}',
      'event: text',
      'data: {"delta":"Hello"}',
      'event: text',
      'data: {"delta":" world"}',
      'event: block',
      'data: {"type":"automation_draft","draft":{"name":"Morning scout"}}',
      'event: action',
      'data: {"type":"start_run"}',
      '',
    ].join('\n')), { onSession, onBlock, onAction })

    expect(text).toBe('Hello world')
    expect(onSession).toHaveBeenCalledWith('s1')
    expect(onBlock).toHaveBeenCalledWith('automation_draft', {
      type: 'automation_draft',
      draft: { name: 'Morning scout' },
    })
    expect(onAction).toHaveBeenCalledWith({ type: 'start_run' })
  })

  it('throws stream error events', async () => {
    await expect(readAgentChatStream(streamFrom([
      'event: error',
      'data: {"message":"Model unavailable"}',
      '',
    ].join('\n')), {
      onSession: vi.fn(),
      onBlock: vi.fn(),
      onAction: vi.fn(),
    })).rejects.toThrow('Model unavailable')
  })

  it('processes the final data line without a trailing newline', async () => {
    const text = await readAgentChatStream(streamFrom([
      'event: text',
      'data: {"delta":"Last chunk"}',
    ].join('\n')), {
      onSession: vi.fn(),
      onBlock: vi.fn(),
      onAction: vi.fn(),
    })

    expect(text).toBe('Last chunk')
  })

  it('flushes a multibyte final chunk before processing the remaining line', async () => {
    const bytes = new TextEncoder().encode([
      'event: text',
      'data: {"delta":"你好"}',
    ].join('\n'))
    const text = await readAgentChatStream(streamFromChunks([
      bytes.slice(0, bytes.length - 1),
      bytes.slice(bytes.length - 1),
    ]), {
      onSession: vi.fn(),
      onBlock: vi.fn(),
      onAction: vi.fn(),
    })

    expect(text).toBe('你好')
  })

  it('keeps legacy ACTION lines out of display text', async () => {
    expect(displayTextFromAgentStream('I will start it now.\nACTION:start_run')).toBe('I will start it now.')
  })

  it('extracts readable response errors', async () => {
    await expect(readableResponseError(new Response(
      JSON.stringify({ error: 'Missing model' }),
      { status: 400 },
    ))).resolves.toBe('Missing model')
  })
})
