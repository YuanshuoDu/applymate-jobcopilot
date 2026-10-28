import { parseAnswerEvidence, type AnswerEvidence } from '@jobcopilot/agent-protocol'
import { redactSensitiveText } from '@jobcopilot/shared/agent-redaction'

import { projectFinalSummary } from './final-summary-projection'

// Defense in depth only: source producers must still build previews from per-kind field allowlists.
const PRIVATE_LOCATORS = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/i,
  /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?::\d{1,5})?(?:\/\S*)?(?![\p{L}\p{N}_-])/iu,
  /\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:\/\S*)?\b/i,
  /\b(?:job|persona|resume|session|turn|step|task|item|call|tool[_-]?call|toolu|source|event|observation|evidence|mapping|map|ref|reference)[:_][a-z0-9][a-z0-9._:-]{0,191}\b/i,
  /\b(?:job|persona|resume|session|turn|step|task|item|call|tool[_-]?call|toolu|source|event|observation|evidence|mapping|map|ref|reference)-(?=[a-z0-9.-]*\d)[a-z0-9][a-z0-9.-]{0,191}\b/i,
  /\bc[a-z0-9]{23,31}\b/i,
  /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b[0-9a-f]{32,64}\b/i,
  /\bE-[a-z0-9_-]+\b|\b(?:tool[_ -]?call[_ -]?id|call[_ -]?id|source[_ -]?digest|sha256:|E[1-8])\b/i,
]

export interface FinalAnswerDisplayContent {
  text: string
  summary?: string
  answerEvidence?: AnswerEvidence
}

/** Keeps final prose aligned with the timeline query's existing credential-only redaction. */
export function redactFinalAnswerText(value: string): string {
  return value
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
}

/** Projects only the strict, bounded manifest shape and removes private locator material. */
export function projectAnswerEvidence(value: unknown): AnswerEvidence | null {
  const parsed = parseAnswerEvidence(value)
  if (!parsed) return null

  const sources = parsed.sources.flatMap((source) => {
    if (PRIVATE_LOCATORS.some((locator) => locator.test(source.label) || locator.test(source.excerpt))) return []
    const label = redactSensitiveText(source.label).trim()
    const excerpt = redactSensitiveText(source.excerpt).trim()
    return label && excerpt ? [{ key: source.key, kind: source.kind, label, excerpt }] : []
  })
  return sources.length > 0 ? parseAnswerEvidence({ schemaVersion: 1, sources }) : null
}

/** Projects the strict final-item DTO used by hydration and replay. */
export function projectFinalAnswerDisplayContent(value: unknown): FinalAnswerDisplayContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const content = value as Record<string, unknown>
  const keys = Object.keys(content)
  const hasSummary = Object.prototype.hasOwnProperty.call(content, 'summary')
  const hasEvidence = Object.prototype.hasOwnProperty.call(content, 'answerEvidence')
  if (keys.length < 1 || keys.length > 3 || !keys.includes('text')
    || keys.some((key) => key !== 'text' && key !== 'summary' && key !== 'answerEvidence') || typeof content.text !== 'string') return null

  let summary: string | undefined
  if (hasSummary) {
    if (typeof content.summary !== 'string' || content.summary.length > 1000) return null
    summary = content.summary
  }
  let answerEvidence: AnswerEvidence | undefined
  if (hasEvidence) {
    const projected = projectAnswerEvidence(content.answerEvidence)
    if (!projected) return null
    answerEvidence = projected
  }
  return { text: content.text, ...(summary === undefined ? {} : { summary }), ...(answerEvidence ? { answerEvidence } : {}) }
}

/** Returns citations only for a completed final-answer timeline item. */
export function projectCompletedAnswerEvidence(value: unknown, phase: unknown, status: unknown): AnswerEvidence | undefined {
  if (phase !== 'final_answer' || status !== 'completed') return undefined
  return projectFinalAnswerContent(value)?.answerEvidence
}

/** Converts a persisted final wrapper to the same small display DTO used by query and SSE. */
export function projectFinalAnswerContent(value: unknown): FinalAnswerDisplayContent | null {
  const content = exactOwnRecord(value, ['text', 'final'])
  const text = ownValue(content, 'text')
  const final = ownRecord(ownValue(content, 'final'))
  if (typeof text !== 'string' || ownValue(final, 'response') !== text) return null

  const summary = projectFinalSummary('agent_message', 'final_answer', 'completed', content)
  const answerEvidence = projectAnswerEvidence(ownValue(final, 'answerEvidence'))
  return {
    text: redactFinalAnswerText(text),
    ...(summary ? { summary } : {}),
    ...(answerEvidence ? { answerEvidence } : {}),
  }
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function exactOwnRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  const record = ownRecord(value)
  if (!record) return null
  try {
    const keys = Reflect.ownKeys(record)
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return null
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      return Boolean(descriptor && Object.hasOwn(descriptor, 'value'))
    }) ? record : null
  } catch {
    return null
  }
}

function ownValue(value: Record<string, unknown> | null, key: string): unknown {
  if (!value) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}
