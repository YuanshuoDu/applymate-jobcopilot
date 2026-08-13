import type { ChatMessage } from '@/lib/model-router'

const HISTORY_EVENT_TYPES = ['user_message', 'orchestrator_plan']
const MAX_HISTORY_EVENTS = 12
const MAX_HISTORY_MESSAGE_LENGTH = 1_200

interface TranscriptHistoryReader {
  agentTranscriptEvent: {
    findMany(args: {
      where: { sessionId: string; type: { in: string[] } }
      orderBy: { createdAt: 'desc' }
      take: number
      select: { type: true; body: true }
    }): Promise<Array<{ type: string; body: string }>>
  }
}

/**
 * Returns only the prior conversational turns for an already-authorized
 * session. The caller authorizes the session with its user ID before reading.
 */
export async function readSessionConversationHistory(
  db: TranscriptHistoryReader,
  sessionId: string,
): Promise<ChatMessage[]> {
  const events = await db.agentTranscriptEvent.findMany({
    where: { sessionId, type: { in: HISTORY_EVENT_TYPES } },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_EVENTS,
    select: { type: true, body: true },
  })

  return events.reverse().flatMap(event => {
    const content = event.body.trim().slice(0, MAX_HISTORY_MESSAGE_LENGTH)
    if (!content) return []
    return [{ role: event.type === 'user_message' ? 'user' : 'assistant', content }]
  })
}
