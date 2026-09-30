export interface QuestionActionRequest {
  readonly sessionId: string
  readonly questionId: string
  readonly expectedTurnId: string
  readonly expectedRevision: number
  readonly answer: string
  readonly clientMessageId: string
}

export interface QuestionActionResult {
  readonly disposition: 'resolved' | 'duplicate'
}

export class AgentQuestionActionError extends Error {
  readonly status: number

  constructor(status: number) {
    super('Question answer request failed')
    this.name = 'AgentQuestionActionError'
    this.status = status
  }
}

let clientMessageSequence = 0

/** Generates a fresh command id without exposing question or answer content. */
export function createAgentQuestionMessageId(): string {
  clientMessageSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-question-${randomId}-${clientMessageSequence}`
}

export function isCurrentAgentQuestionRequest(currentEpoch: number, requestEpoch: number, currentSelectionKey: string, requestSelectionKey: string): boolean {
  return currentEpoch === requestEpoch && currentSelectionKey === requestSelectionKey
}

export async function postAgentQuestionAnswer(request: QuestionActionRequest, fetcher: typeof fetch = fetch): Promise<QuestionActionResult> {
  if (!request.answer.trim() || request.answer.trim() !== request.answer || new TextEncoder().encode(request.answer).byteLength > 20_000) throw new AgentQuestionActionError(422)
  try {
    const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(request.sessionId)}/questions/${encodeURIComponent(request.questionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
      body: JSON.stringify({ clientMessageId: request.clientMessageId, expectedTurnId: request.expectedTurnId, expectedRevision: request.expectedRevision, answer: request.answer }),
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok || response.status !== 202) throw new AgentQuestionActionError(response.status)
    if (!isRecord(body) || (body.disposition !== 'resolved' && body.disposition !== 'duplicate')) throw new AgentQuestionActionError(response.status)
    return { disposition: body.disposition }
  } catch (error: unknown) {
    if (error instanceof AgentQuestionActionError) throw error
    throw new AgentQuestionActionError(0)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
