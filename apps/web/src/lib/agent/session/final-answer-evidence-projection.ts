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
const SOURCE_MARKER_START = /\[\[[ \t]*source\b[ \t]*:?/ig
const COMPLETE_SOURCE_MARKER = /^\[\[source:(S[1-8])\]\]$/

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
    answerEvidence = projectAnswerEvidence(content.answerEvidence) ?? undefined
  }
  const text = hasEvidence ? stripUnprojectedSourceMarkers(content.text, sourceKeys(answerEvidence)) : content.text
  return { text, ...(summary === undefined ? {} : { summary }), ...(answerEvidence ? { answerEvidence } : {}) }
}

/** Returns citations only for a completed final-answer timeline item. */
export function projectCompletedAnswerEvidence(value: unknown, phase: unknown, status: unknown): AnswerEvidence | undefined {
  if (phase !== 'final_answer' || status !== 'completed') return undefined
  return projectFinalAnswerContent(value)?.answerEvidence
}

/** Keeps old answer text intact unless its stored wrapper opted into source metadata. */
export function projectFinalAnswerText(
  value: unknown,
  projected?: { answerEvidence?: AnswerEvidence },
): string | undefined {
  const wrapper = ownRecord(value)
  const text = ownValue(wrapper, 'text')
  if (typeof text !== 'string') return undefined

  const finalValue = ownValue(wrapper, 'final')
  const final = ownRecord(finalValue)
  if (!hasOwnField(final, 'answerEvidence')) return redactFinalAnswerText(text)

  const evidence = projected === undefined
    ? exactOwnRecord(value, ['text', 'final']) && ownValue(final, 'response') === text
      ? projectAnswerEvidence(ownValue(final, 'answerEvidence')) ?? undefined
      : undefined
    : projected.answerEvidence
  return stripUnprojectedSourceMarkers(redactFinalAnswerText(text), sourceKeys(evidence))
}

/** Converts a persisted final wrapper to the same small display DTO used by query and SSE. */
export function projectFinalAnswerContent(value: unknown): FinalAnswerDisplayContent | null {
  const content = exactOwnRecord(value, ['text', 'final'])
  const text = ownValue(content, 'text')
  const final = ownRecord(ownValue(content, 'final'))
  if (typeof text !== 'string' || ownValue(final, 'response') !== text) return null

  const summary = projectFinalSummary('agent_message', 'final_answer', 'completed', content)
  const answerEvidence = projectAnswerEvidence(ownValue(final, 'answerEvidence'))
  const textProjection = projectFinalAnswerText(value, { answerEvidence: answerEvidence ?? undefined })
  if (textProjection === undefined) return null
  return {
    text: textProjection,
    ...(summary ? { summary } : {}),
    ...(answerEvidence ? { answerEvidence } : {}),
  }
}

function sourceKeys(evidence: AnswerEvidence | undefined): ReadonlySet<string> {
  return new Set(evidence?.sources.map((source) => source.key) ?? [])
}

function hasOwnField(value: Record<string, unknown> | null, key: string): boolean {
  if (!value) return false
  try {
    return Object.getOwnPropertyDescriptor(value, key) !== undefined
  } catch {
    return true
  }
}

function stripUnprojectedSourceMarkers(text: string, allowedKeys: ReadonlySet<string>): string {
  const output: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  SOURCE_MARKER_START.lastIndex = 0
  while ((match = SOURCE_MARKER_START.exec(text)) !== null) {
    const start = match.index
    const contentStart = SOURCE_MARKER_START.lastIndex
    output.push(text.slice(cursor, start))
    const nextOpen = SOURCE_MARKER_START.exec(text)?.index ?? text.length
    const lineBreak = /[\r\n]/g
    lineBreak.lastIndex = start
    const lineBoundary = lineBreak.exec(text)?.index ?? text.length
    const boundary = Math.min(nextOpen, lineBoundary)
    const close = text.indexOf(']]', contentStart)
    if (close >= contentStart && close < boundary) {
      const marker = text.slice(start, close + 2)
      const canonical = COMPLETE_SOURCE_MARKER.exec(marker)
      if (canonical && allowedKeys.has(canonical[1]!)) output.push(marker)
      cursor = close + 2
    } else {
      const remainder = text.slice(contentStart, boundary)
      const whitespace = remainder.search(/[ \t\r\n]/)
      let end = whitespace < 0 ? boundary : contentStart + whitespace
      const singleClose = text.indexOf(']', contentStart)
      if (singleClose >= contentStart && singleClose < boundary && text[singleClose + 1] !== ']' && singleClose < end) {
        end = singleClose + 1
      }
      cursor = Math.max(end, contentStart)
    }
    SOURCE_MARKER_START.lastIndex = cursor
  }
  output.push(text.slice(cursor))
  return output.join('')
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
