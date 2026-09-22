import type { ApplicationAuditTarget } from '@/lib/types'

export type ResumeChangeSource = 'ai_insights' | 'audit'
export type ResumeChangeSection = ApplicationAuditTarget

export type ResumeChange = {
  id: string
  source: ResumeChangeSource
  section: ResumeChangeSection
  before: string
  after: string
  createdAt: number
}

export type DiffChunk = {
  type: 'same' | 'added' | 'removed'
  text: string
}

export type TextDiff = {
  before: DiffChunk[]
  after: DiffChunk[]
}

const MAX_DIFF_LENGTH = 6_000
const MAX_LCS_CELLS = 2_000_000

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function formatRecordList(value: unknown, formatter: (item: Record<string, unknown>) => string) {
  if (!Array.isArray(value)) return ''
  return value
    .map(item => record(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(formatter)
    .filter(Boolean)
    .join('\n\n')
}

/** Keep AI changes readable in the editor instead of exposing raw JSON. */
export function formatResumeChangeValue(section: ResumeChangeSection, value: unknown) {
  if (section === 'summary' || section === 'cover_letter') return text(value).slice(0, MAX_DIFF_LENGTH)
  if (section === 'skills') return textList(value).join('\n').slice(0, MAX_DIFF_LENGTH)
  if (section === 'contact') {
    const contact = record(value)
    if (!contact) return ''
    return ['name', 'email', 'location', 'phone', 'linkedin', 'github', 'website']
      .map(key => `${key}: ${text(contact[key])}`)
      .filter(line => line.split(': ').slice(1).join(': '))
      .join('\n')
      .slice(0, MAX_DIFF_LENGTH)
  }
  if (section === 'experience') {
    return formatRecordList(value, item => {
      const heading = [text(item.role), text(item.company), text(item.period)].filter(Boolean).join(' · ')
      const bullets = textList(item.bullets).map(bullet => `• ${bullet}`).join('\n')
      return [heading, bullets].filter(Boolean).join('\n')
    }).slice(0, MAX_DIFF_LENGTH)
  }
  if (section === 'education') {
    return formatRecordList(value, item => [text(item.degree), text(item.institution), text(item.year)].filter(Boolean).join(' · ')).slice(0, MAX_DIFF_LENGTH)
  }
  if (section === 'languages') {
    return formatRecordList(value, item => [text(item.lang), text(item.level)].filter(Boolean).join(' · ')).slice(0, MAX_DIFF_LENGTH)
  }
  if (section === 'projects') {
    return formatRecordList(value, item => {
      const heading = [text(item.name), text(item.role), text(item.period)].filter(Boolean).join(' · ')
      const bullets = textList(item.bullets).map(bullet => `• ${bullet}`).join('\n')
      return [heading, bullets].filter(Boolean).join('\n')
    }).slice(0, MAX_DIFF_LENGTH)
  }
  if (section === 'certifications') {
    return formatRecordList(value, item => [text(item.name), text(item.issuer), text(item.date)].filter(Boolean).join(' · ')).slice(0, MAX_DIFF_LENGTH)
  }
  if (typeof value === 'string') return value.slice(0, MAX_DIFF_LENGTH)
  const serialized = JSON.stringify(value, null, 2)
  return (serialized ?? '').slice(0, MAX_DIFF_LENGTH)
}

function tokenize(value: string) {
  return value.match(/\s+|[A-Za-z0-9À-ÿ_]+|[^\sA-Za-z0-9À-ÿ_]/g) ?? []
}

function appendChunk(chunks: DiffChunk[], type: DiffChunk['type'], token: string) {
  const previous = chunks[chunks.length - 1]
  if (previous?.type === type) previous.text += token
  else chunks.push({ type, text: token })
}

/** Word/punctuation-level LCS diff so sentence and paragraph edits stay legible. */
export function diffResumeText(before: string, after: string): TextDiff {
  const left = tokenize(before.slice(0, MAX_DIFF_LENGTH))
  const right = tokenize(after.slice(0, MAX_DIFF_LENGTH))
  if (left.length * right.length > MAX_LCS_CELLS) {
    return {
      before: left.length > 0 ? [{ type: 'removed', text: before.slice(0, MAX_DIFF_LENGTH) }] : [],
      after: right.length > 0 ? [{ type: 'added', text: after.slice(0, MAX_DIFF_LENGTH) }] : [],
    }
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const beforeChunks: DiffChunk[] = []
  const afterChunks: DiffChunk[] = []
  let i = 0; let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      appendChunk(beforeChunks, 'same', left[i]); appendChunk(afterChunks, 'same', right[j]); i += 1; j += 1
    } else if (i < left.length && (j === right.length || table[i + 1][j] >= table[i][j + 1])) {
      appendChunk(beforeChunks, 'removed', left[i]); i += 1
    } else {
      appendChunk(afterChunks, 'added', right[j]); j += 1
    }
  }
  return { before: beforeChunks, after: afterChunks }
}
