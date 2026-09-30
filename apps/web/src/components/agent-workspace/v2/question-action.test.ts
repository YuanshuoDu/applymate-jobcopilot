import { describe, expect, it, vi } from 'vitest'

import { AgentQuestionActionError, createAgentQuestionMessageId, isCurrentAgentQuestionRequest, postAgentQuestionAnswer } from './question-action'

describe('question answer command', () => {
  it('posts only the canonical Broker answer contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'resolved' }), { status: 202 }))
    const clientMessageId = createAgentQuestionMessageId()
    await expect(postAgentQuestionAnswer({ sessionId: 'session/1', questionId: 'question/1', expectedTurnId: 'turn-1', expectedRevision: 7, answer: 'yes', clientMessageId }, fetcher)).resolves.toEqual({ disposition: 'resolved' })
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2F1/questions/question%2F1', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
      body: JSON.stringify({ clientMessageId, expectedTurnId: 'turn-1', expectedRevision: 7, answer: 'yes' }),
    }))
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('scope')
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('taskId')
  })

  it('accepts duplicate acknowledgements and hides non-2xx or malformed server details', async () => {
    const request = { sessionId: 'session-1', questionId: 'question-1', expectedTurnId: 'turn-1', expectedRevision: 1, answer: 'yes', clientMessageId: 'message-1' }
    await expect(postAgentQuestionAnswer(request, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ disposition: 'duplicate', message: 'private' }), { status: 202 })))).resolves.toEqual({ disposition: 'duplicate' })
    await expect(postAgentQuestionAnswer(request, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'private' }), { status: 409 })))).rejects.toMatchObject({ status: 409 })
    await expect(postAgentQuestionAnswer(request, vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 202 })))).rejects.toBeInstanceOf(AgentQuestionActionError)
    await expect(postAgentQuestionAnswer(request, vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail')))).rejects.toMatchObject({ status: 0 })
  })

  it('rejects blank or oversized answers and fences stale responses', async () => {
    const request = { sessionId: 'session-1', questionId: 'question-1', expectedTurnId: 'turn-1', expectedRevision: 1, answer: ' ', clientMessageId: 'message-blank' }
    await expect(postAgentQuestionAnswer(request, vi.fn<typeof fetch>())).rejects.toMatchObject({ status: 422 })
    await expect(postAgentQuestionAnswer({ ...request, answer: 'x'.repeat(20_001), clientMessageId: 'message-large' }, vi.fn<typeof fetch>())).rejects.toMatchObject({ status: 422 })
    expect(isCurrentAgentQuestionRequest(2, 2, 'same', 'same')).toBe(true)
    expect(isCurrentAgentQuestionRequest(3, 2, 'same', 'same')).toBe(false)
    expect(isCurrentAgentQuestionRequest(2, 2, 'new', 'old')).toBe(false)
  })
})
