import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const QUESTION_MAX_OPTIONS = 16
export const QUESTION_MAX_TEXT_BYTES = 4 * 1024
export const QUESTION_MAX_OPTION_VALUE_BYTES = 512
export const QUESTION_MAX_OPTION_LABEL_BYTES = 1 * 1024

export type QuestionInputStatus = 'pending' | 'answered' | 'cancelled'

export interface QuestionInputOption {
  readonly value: string
  readonly label: string
}

export interface QuestionInputProjection {
  readonly itemId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string | null
  readonly questionId: string
  readonly stage: string
  readonly question: string
  readonly options: readonly QuestionInputOption[]
  readonly status: QuestionInputStatus
  readonly revision: number
}

export interface QuestionTerminalEvent {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string
  readonly taskId: string | null
  readonly sequence: string
  readonly status: 'completed' | 'interrupted'
  readonly questionId: string
  readonly createdAt?: string
}

type RecordValue = Record<string, unknown>

/** Parses only canonical question items and drops OAuth or narrative variants. */
export function parseQuestionInputItem(value: unknown, expectedSessionId: string): QuestionInputProjection | null {
  if (!isRecord(value) || value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || value.type !== 'question' || value.sessionId !== expectedSessionId ||
    !safeId(value.id) || !safeId(value.turnId) || (value.taskId !== null && !safeId(value.taskId)) || !isSafeRevision(value.revision) || typeof value.status !== 'string' || !isRecord(value.content)) return null
  const content = value.content
  if (!exact(content, ['waitKind', 'questionId', 'stage', 'question'], ['options', 'toolCallId', 'answer', 'answeredAt', 'pending', 'answerAvailable', 'oauth', 'cancelled', 'cancellationReason']) || content.waitKind !== 'question' ||
    !safeId(content.questionId) || !safeText(content.stage, QUESTION_MAX_TEXT_BYTES) || !safeText(content.question, QUESTION_MAX_TEXT_BYTES) || (content.answerAvailable !== undefined && typeof content.answerAvailable !== 'boolean') ||
    (content.options !== undefined && !parseOptions(content.options)) || (content.toolCallId !== undefined && content.toolCallId !== null && !safeId(content.toolCallId)) ||
    (content.answer !== undefined && content.answer !== null && !safeText(content.answer, 20 * 1024)) || (content.answeredAt !== undefined && !safeText(content.answeredAt, 128)) ||
    (content.pending !== undefined && typeof content.pending !== 'boolean') || (content.oauth !== undefined && typeof content.oauth !== 'boolean') || content.oauth === true ||
    (content.cancelled !== undefined && typeof content.cancelled !== 'boolean') || (content.cancellationReason !== undefined && content.cancellationReason !== 'interrupt')) return null
  const options = content.options === undefined ? [] : parseOptions(content.options)
  if (!options) return null
  const status = value.status === 'started' && content.pending === true && content.answerAvailable !== true
    ? 'pending'
    : value.status === 'completed' && content.answerAvailable === true
      ? 'answered'
      : value.status === 'interrupted' && content.cancelled === true && content.cancellationReason === 'interrupt'
        ? 'cancelled' : null
  if (!status) return null
  return { itemId: value.id, sessionId: value.sessionId, turnId: value.turnId, taskId: value.taskId as string | null, questionId: content.questionId, stage: content.stage, question: content.question, options, status, revision: value.revision }
}

/** Validates the two server terminal facts without accepting raw answers. */
export function parseQuestionTerminalEvent(value: unknown, expectedSessionId: string): QuestionTerminalEvent | null {
  if (!isRecord(value) || !exact(value, ['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'sequence', 'payload'], ['correlationId', 'causationId', 'idempotencyKey', 'createdAt']) || value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || value.sessionId !== expectedSessionId || !safeId(value.id) || !safeId(value.turnId) ||
    typeof value.itemId !== 'string' || !safeId(value.itemId) || (value.taskId !== null && !safeId(value.taskId)) || typeof value.sequence !== 'string' || !/^(0|[1-9]\d*)$/.test(value.sequence) || value.sequence.length > 39 ||
    (value.type !== 'question.answered' && value.type !== 'question.cancelled') || (value.type === 'question.answered' ? value.actor !== 'user' : value.actor !== 'system') ||
    !isRecord(value.payload) || !exact(value.payload, value.type === 'question.answered'
      ? ['waitKind', 'waitId', 'itemId', 'turnId', 'toolCallId', 'status', 'nextTurnRevision', 'answerAvailable']
      : ['waitKind', 'waitId', 'itemId', 'toolCallId', 'outcome', 'reason']) || value.payload.waitKind !== 'question' || !safeId(value.payload.waitId) || value.payload.itemId !== value.itemId ||
    (value.payload.toolCallId !== null && !safeId(value.payload.toolCallId)) || (value.type === 'question.answered' && (value.payload.turnId !== value.turnId || value.payload.status !== 'answered' || value.payload.answerAvailable !== true || !isSafeRevision(value.payload.nextTurnRevision))) ||
    (value.type === 'question.cancelled' && (value.payload.outcome !== 'cancelled' || value.payload.reason !== 'interrupt')) ||
    (value.correlationId !== undefined && !safeId(value.correlationId)) || (value.causationId !== undefined && value.causationId !== null && !safeId(value.causationId)) ||
    (value.idempotencyKey !== undefined && value.idempotencyKey !== null && !safeId(value.idempotencyKey)) ||
    (value.createdAt !== undefined && !safeText(value.createdAt, 128))) return null
  return { id: value.id, sessionId: value.sessionId, turnId: value.turnId, itemId: value.itemId, taskId: value.taskId as string | null, sequence: value.sequence, status: value.type === 'question.answered' ? 'completed' : 'interrupted', questionId: value.payload.waitId, ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }) }
}

function parseOptions(value: unknown): QuestionInputOption[] | null {
  if (!Array.isArray(value) || value.length > QUESTION_MAX_OPTIONS) return null
  const options: QuestionInputOption[] = []
  for (const option of value) {
    if (!isRecord(option) || !exact(option, ['value', 'label']) || !safeText(option.value, QUESTION_MAX_OPTION_VALUE_BYTES) || !safeText(option.label, QUESTION_MAX_OPTION_LABEL_BYTES) || options.some(entry => entry.value === option.value)) return null
    options.push({ value: option.value, label: option.label })
  }
  return options
}

function exact(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function safeId(value: unknown): value is string { return safeText(value, 256) }
function safeText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false
  return new TextEncoder().encode(value).byteLength <= maxBytes
}
function isSafeRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 }
function isRecord(value: unknown): value is RecordValue { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
