import {
  parseVerifiedShortlistSelectionBinding,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  TurnIntentSchema,
  validate,
  type VerifiedShortlistSelectionBinding,
} from '@jobcopilot/agent-protocol'

const BATCH_GOAL = 'Prepare draft materials for the selected Jobs from the verified shortlist. Do not submit applications.'
const INPUT_KEYS = ['clientMessageId', 'content', 'goal', 'intent', 'verifiedShortlistSelection']

export function parseSelectedJobBatchTurnIdentity(value: unknown): VerifiedShortlistSelectionBinding | null {
  const input = exactRecord(value, INPUT_KEYS)
  const intent = exactRecord(input?.intent, ['kind', 'version'])
  const content = Array.isArray(input?.content) ? input.content : []
  const part = exactRecord(content[0], ['type', 'text'])
  if (!input || !safeText(input.clientMessageId, 128) || input.goal !== BATCH_GOAL || content.length !== 1
    || !part || part.type !== 'text' || part.text !== BATCH_GOAL || !intent || !validate(TurnIntentSchema, intent)
    || intent.kind !== SELECTED_JOB_BATCH_PREPARATION_INTENT.kind || intent.version !== SELECTED_JOB_BATCH_PREPARATION_INTENT.version) return null
  return parseVerifiedShortlistSelectionBinding(input.verifiedShortlistSelection)
}

/** Keeps the existing single-Job Turn projection beside its batch identity marker. */
export function projectSelectedJobId(value: unknown): string | null {
  const selected = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return Object.keys(selected).length === 1 && boundedIdentifier(selected.jobId) ? selected.jobId : null
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = dataRecord(value)
  return row && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) ? row : null
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown } catch { return null } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== 'string')) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}
