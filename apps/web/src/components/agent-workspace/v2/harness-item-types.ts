import type { TimelineItem } from './timeline-reducer'

export interface TextContentPart {
  type: 'text'
  text: string
}

export interface AttachmentRefContentPart {
  type: 'attachment_ref'
  artifactId: string
  hash: string
}

export interface JobTableContentPart {
  type: 'job_table'
  jobIds: string[]
  columns: string[]
}

export interface ArtifactCardContentPart {
  type: 'artifact_card'
  artifactId: string
  label: string
}

export interface SuggestedActionContentPart {
  type: 'suggested_action'
  command: string
  arguments: unknown
}

export interface CitationContentPart {
  type: 'citation'
  evidenceId: string
  label: string
}

export interface RedactedContentPart {
  type: 'redacted'
}

export interface UnknownContentPart {
  type: 'unknown'
  rawType: string | null
}

export type HarnessContentPart =
  | TextContentPart
  | AttachmentRefContentPart
  | JobTableContentPart
  | ArtifactCardContentPart
  | SuggestedActionContentPart
  | CitationContentPart
  | RedactedContentPart
  | UnknownContentPart

export interface SuggestedActionCommand {
  command: string
  arguments: unknown
}

export function contentParts(content: unknown): HarnessContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.map(toContentPart)
  if (!isRecord(content)) return [{ type: 'unknown', rawType: null }]

  if (Array.isArray(content.parts)) return content.parts.map(toContentPart)
  if (typeof content.text === 'string') return [{ type: 'text', text: content.text }]
  if (typeof content.body === 'string') return [{ type: 'text', text: content.body }]
  return [{ type: 'unknown', rawType: stringValue(content.type) }]
}

export function itemText(item: TimelineItem): string {
  const parts = contentParts(item.content)
  return parts
    .filter((part): part is TextContentPart => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function toContentPart(value: unknown): HarnessContentPart {
  if (!isRecord(value) || typeof value.type !== 'string') return { type: 'unknown', rawType: null }
  switch (value.type) {
    case 'text': return typeof value.text === 'string' ? { type: 'text', text: value.text } : { type: 'unknown', rawType: 'text' }
    case 'attachment_ref': return hasStrings(value, 'artifactId', 'hash') ? { type: 'attachment_ref', artifactId: value.artifactId, hash: value.hash } : { type: 'unknown', rawType: value.type }
    case 'job_table': return { type: 'job_table', jobIds: stringArray(value.jobIds), columns: stringArray(value.columns) }
    case 'artifact_card': return hasStrings(value, 'artifactId', 'label') ? { type: 'artifact_card', artifactId: value.artifactId, label: value.label } : { type: 'unknown', rawType: value.type }
    case 'suggested_action': return typeof value.command === 'string' && value.command.trim() ? { type: 'suggested_action', command: value.command, arguments: value.arguments ?? null } : { type: 'unknown', rawType: value.type }
    case 'citation': return hasStrings(value, 'evidenceId', 'label') ? { type: 'citation', evidenceId: value.evidenceId, label: value.label } : { type: 'unknown', rawType: value.type }
    case 'redacted': return { type: 'redacted' }
    default: return { type: 'unknown', rawType: value.type }
  }
}

function hasStrings(value: Record<string, unknown>, ...keys: string[]): value is Record<string, string> {
  return keys.every(key => typeof value[key] === 'string' && value[key].length > 0)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
