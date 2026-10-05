import { modelChat, type AiConfig } from '@/lib/model-router'
import type { AgentConfigFull } from './types'

export interface OrchestratorDecision {
  decision: 'proceed' | 'retry' | 'ask_user' | 'abort'
  thinking: string
  ask_question?: string
  ask_options?: Array<{ label: string; value: string; action?: { field: string; value: unknown } }>
  retry_fix?: Record<string, unknown>
}

export interface OrchestratorEvaluationContext {
  agentCfg: Pick<AgentConfigFull, 'targetRoles' | 'targetLocations' | 'minMatchScore' | 'dailyLimit' | 'autoApply' | 'throttleMs'>
  aiConfig: AiConfig
}

/** Safe, stable failure surfaced when the model cannot supply a valid decision. */
export class OrchestratorDecisionError extends Error {
  readonly code = 'orchestrator_decision_invalid'

  constructor() {
    super('The agent stopped because the orchestrator could not produce a valid decision. Please retry the run.')
    this.name = 'OrchestratorDecisionError'
  }
}

/** Strip common chain-of-thought preambles and return only actionable text. */
export function extractFinalSentence(raw: string): string {
  const lines = raw.split('\n').filter(line => line.trim())
  const thinkPrefixes = [
    'let me', 'i need to', 'the user wants', 'i should', 'first,', 'okay,',
    'sure,', 'to answer', 'thinking:', 'i\'ll', 'i will', 'as an',
  ]
  for (const line of lines) {
    const lower = line.trim().toLowerCase()
    if (!thinkPrefixes.some(prefix => lower.startsWith(prefix)) && line.trim().length > 10) {
      return line.trim().replace(/^[*_`#>\-•·]+\s*/, '').replace(/[*_`]+$/, '').slice(0, 120)
    }
  }
  const sentences = raw.replace(/\n/g, ' ').split(/[.!?]+/).filter(sentence => sentence.trim().length > 10)
  return (sentences.at(-1) ?? raw).trim().slice(0, 120)
}

const MAX_DECISION_RESPONSE_CHARS = 16_000
const MAX_THINKING_CHARS = 1_000
const MAX_QUESTION_CHARS = 500
const MAX_OPTION_LABEL_CHARS = 120
const MAX_OPTION_VALUE_CHARS = 120
const MAX_ACTION_FIELD_CHARS = 100
const MAX_NESTED_VALUE_CHARS = 2_000
export const MAX_RETRY_THROTTLE_MS = 60_000
const DEFAULT_RETRY_THROTTLE_MS = 300
const RETRYABLE_MODEL_FIX_STAGES = new Set(['scout', 'analyst'])

export function parseDecision(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_DECISION_RESPONSE_CHARS) return null
  const text = raw.replace(/```json|```/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isBoundedJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= MAX_NESTED_VALUE_CHARS
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 20 && value.every(item => isBoundedJsonValue(item, depth + 1))
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 20 && entries.every(([key, item]) =>
    key.length > 0 && key.length <= MAX_ACTION_FIELD_CHARS && isBoundedJsonValue(item, depth + 1),
  )
}

export function isValidRetryFix(
  value: unknown,
  stage: string,
  currentThrottleMs: number | undefined,
): value is Record<string, unknown> & { throttleMs: number } {
  if (!RETRYABLE_MODEL_FIX_STAGES.has(stage) || !isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 1 || keys[0] !== 'throttleMs' || !hasOwn(value, 'throttleMs')) return false

  const current = currentThrottleMs ?? DEFAULT_RETRY_THROTTLE_MS
  const requested = value.throttleMs
  return Number.isInteger(current)
    && current >= 0
    && current <= MAX_RETRY_THROTTLE_MS
    && typeof requested === 'number'
    && Number.isInteger(requested)
    && requested >= current
    && requested <= MAX_RETRY_THROTTLE_MS
}

export function validateDecision(
  value: unknown,
  autonomous: boolean,
  stage: string,
  currentThrottleMs: number | undefined,
): OrchestratorDecision | null {
  if (!isRecord(value)) return null
  if (!['proceed', 'retry', 'ask_user', 'abort'].includes(value.decision as string)) return null
  if (!boundedString(value.thinking, MAX_THINKING_CHARS)) return null
  const thinking = extractFinalSentence(value.thinking.trim())
  if (!thinking) return null

  switch (value.decision) {
    case 'proceed':
    case 'abort':
      return { decision: value.decision, thinking }
    case 'retry': {
      const retryFix = value.retry_fix
      if (!isValidRetryFix(retryFix, stage, currentThrottleMs)) return null
      return { decision: 'retry', thinking, retry_fix: retryFix }
    }
    case 'ask_user': {
      if (autonomous || !boundedString(value.ask_question, MAX_QUESTION_CHARS)) return null
      let askOptions: OrchestratorDecision['ask_options']
      if (hasOwn(value, 'ask_options')) {
        if (!Array.isArray(value.ask_options) || value.ask_options.length === 0 || value.ask_options.length > 10) return null
        const parsedOptions: NonNullable<OrchestratorDecision['ask_options']> = []
        const seenValues = new Set<string>()
        for (const option of value.ask_options) {
          if (!isRecord(option) || !boundedString(option.label, MAX_OPTION_LABEL_CHARS) || !boundedString(option.value, MAX_OPTION_VALUE_CHARS)) return null
          const optionValue = option.value.trim()
          if (seenValues.has(optionValue)) return null
          seenValues.add(optionValue)

          let action: NonNullable<OrchestratorDecision['ask_options']>[number]['action']
          if (hasOwn(option, 'action')) {
            if (!isRecord(option.action) || !boundedString(option.action.field, MAX_ACTION_FIELD_CHARS) || !hasOwn(option.action, 'value')) return null
            if (!isBoundedJsonValue(option.action.value)) return null
            let serialized: string
            try { serialized = JSON.stringify(option.action.value) }
            catch { return null }
            if (typeof serialized !== 'string' || serialized.length > MAX_NESTED_VALUE_CHARS) return null
            action = { field: option.action.field.trim(), value: option.action.value }
          }
          parsedOptions.push({ label: option.label.trim(), value: optionValue, ...(action ? { action } : {}) })
        }
        askOptions = parsedOptions
      }
      return { decision: 'ask_user', thinking, ask_question: value.ask_question.trim(), ...(askOptions ? { ask_options: askOptions } : {}) }
    }
    default:
      return null
  }
}

export async function evaluateOrchestratorDecision(
  stage: string,
  summary: string,
  metrics: Record<string, unknown>,
  context: OrchestratorEvaluationContext,
  autonomous: boolean,
  history: readonly string[],
): Promise<OrchestratorDecision> {
  const { agentCfg } = context
  const historyStr = history.slice(-4).join('\n')
  const prompt = `You are an OrchestratorAgent. A pipeline stage just completed.

Stage: ${stage}
Summary: ${summary}
Metrics: ${JSON.stringify(metrics)}
User config: minScore=${agentCfg.minMatchScore}%, dailyLimit=${agentCfg.dailyLimit}, autoApply=${agentCfg.autoApply}
Recent history:
${historyStr}
Autonomous mode: ${autonomous}

Decide what to do next. Rules:
- Only ask_user if something truly needs human judgment (e.g., all jobs skipped, major config conflict)
- In autonomous mode: NEVER ask_user, always proceed or retry with sensible defaults
- retry only on Scout or Analyst, the stages with bounded retry paths
- retry_fix must contain exactly one key: throttleMs, an integer from the current runtime value (default 300ms) through 60000ms
- a retry may slow the run but must never change consent, automation mode, search criteria, model, or any other user setting
- abort only if pipeline literally cannot continue (0 jobs + 0 from any source)
- proceed in all other cases

Respond ONLY in valid JSON (no markdown):
{
  "decision": "proceed" | "retry" | "ask_user" | "abort",
  "thinking": "<one sentence why>",
  "ask_question": "<question for user, only if ask_user>",
  "ask_options": [{"label":"...", "value":"..."}],
  "retry_fix": {"throttleMs": 600}
}`

  let decision: OrchestratorDecision | null = null
  try {
    const response = await modelChat([{ role: 'user', content: prompt }], context.aiConfig, 400)
    decision = validateDecision(parseDecision(response.text), autonomous, stage, agentCfg.throttleMs)
  } catch {
    throw new OrchestratorDecisionError()
  }
  if (!decision) throw new OrchestratorDecisionError()
  return decision
}
