import { describe, expect, it, vi } from 'vitest'
import { readSessionConversationHistory } from './session-history'

describe('readSessionConversationHistory', () => {
  it('keeps only bounded prior conversation turns from the selected session', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { type: 'orchestrator_plan', body: '  Earlier answer  ' },
      { type: 'user_message', body: 'Earlier question' },
      { type: 'orchestrator_plan', body: '   ' },
    ])

    const history = await readSessionConversationHistory(
      { agentTranscriptEvent: { findMany } },
      'session_owned',
    )

    expect(findMany).toHaveBeenCalledWith({
      where: { sessionId: 'session_owned', type: { in: ['user_message', 'orchestrator_plan'] } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { type: true, body: true },
    })
    expect(history).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ])
  })
})
