import React from 'react'

import type { AgentTimelineSnapshot } from './use-agent-timeline'

export interface SelectedEvidenceProjection {
  readonly itemId: string | null
  readonly type: string
  readonly status: string
  readonly toolName: string | null
  readonly toolCallId: string | null
  readonly resultAvailable: boolean
  readonly referenceIds: readonly string[]
}

/** Projects selected timeline evidence without traversing or rendering raw payload values. */
export function projectSelectedEvidence(item: NonNullable<AgentTimelineSnapshot['items']>[number]): SelectedEvidenceProjection {
  const base: SelectedEvidenceProjection = {
    itemId: safeStableId(item.id), type: safeToken(item.type) ?? 'unknown', status: safeToken(item.status) ?? 'unknown',
    toolName: null, toolCallId: null, resultAvailable: item.type === 'tool_result', referenceIds: [],
  }
  const content = projectEvidenceContent(item.content)
  return content ? { ...base, ...content } : base
}

export function EvidenceSummary({ item, t }: { item: NonNullable<AgentTimelineSnapshot['items']>[number]; t: (key: string) => string }) {
  const evidence = projectSelectedEvidence(item)
  return (
    <div data-agent-supervisor-evidence="true" style={{ display: 'grid', gap: 4, paddingTop: 8, color: 'var(--text-muted)', fontSize: 10 }}>
      <span>{t('agent.type')}: {itemTypeLabel(evidence.type, t)}{evidence.itemId ? ` · ${evidence.itemId}` : ''}</span>
      <span>{t('agent.itemStatus')}: {statusLabel(evidence.status, t)}</span>
      {item.completedAt && <span>{t('agent.complete')}: {new Date(item.completedAt).toLocaleString()}</span>}
      {evidence.toolName && <span>{t('agent.toolActor')}: {evidence.toolName}</span>}
      {evidence.toolCallId && <span>{t('agent.toolCall')}: {evidence.toolCallId}</span>}
      <span>{t('agent.toolResult')}: {evidence.resultAvailable ? t('agent.complete') : t('agent.notAvailable')}</span>
      {evidence.referenceIds.length > 0 && <span>{t('agent.citation')}: {evidence.referenceIds.join(', ')}</span>}
    </div>
  )
}

function itemTypeLabel(type: string, t: (key: string) => string): string {
  if (type === 'agent_message') return t('agent.messageTitle')
  if (type === 'plan') return t('agent.plan')
  if (type === 'tool_call') return t('agent.toolCall')
  if (type === 'tool_result') return t('agent.toolResult')
  if (type === 'reasoning_summary') return t('agent.reasoningSummary')
  return t('agent.harnessItem')
}

const MAX_EVIDENCE_STRING = 256, MAX_EVIDENCE_CONTENT = 4096, MAX_EVIDENCE_NODES = 96, MAX_EVIDENCE_ARRAY = 32, MAX_EVIDENCE_REFERENCES = 16, MAX_EVIDENCE_DEPTH = 5
const SAFE_EVIDENCE_KEYS = new Set(['artifactId', 'artifactRefs', 'columns', 'error', 'errorCode', 'evidenceId', 'evidenceIds', 'evidenceRefs', 'hash', 'input', 'jobId', 'jobIds', 'label', 'name', 'output', 'outputAvailable', 'outputSummary', 'parts', 'referenceId', 'referenceIds', 'references', 'result', 'resultAvailable', 'status', 'text', 'toolCallId', 'toolName', 'type'])
const OPAQUE_EVIDENCE_KEYS = new Set(['error', 'input', 'output', 'outputSummary', 'result'])
const SAFE_PART_TYPES = new Set(['artifact_card', 'attachment_ref', 'citation', 'job_table', 'redacted', 'text'])
const SENSITIVE_ID = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|credential|secret|bearer|session|user|lease|budget)/i
interface EvidenceContentProjection { toolName: string | null; toolCallId: string | null; resultAvailable?: boolean; referenceIds: string[] }
interface EvidenceBudget { characters: number; nodes: number }

function projectEvidenceContent(value: unknown): EvidenceContentProjection | null {
  try {
    const root = Array.isArray(value) ? { parts: value } : value
    if (!isPlainRecord(root) || !validateEvidenceValue(root, new Set(), 0, { characters: 0, nodes: 0 })) return null
    const toolName = optionalStableField(root, 'toolName', 'name'), toolCallId = optionalStableField(root, 'toolCallId', 'allowNull'), result = readOutputAvailability(root), referenceIds = readReferenceIds(root)
    return toolName.valid && toolCallId.valid && result.valid && referenceIds ? { toolName: toolName.value, toolCallId: toolCallId.value, ...(result.value === undefined ? {} : { resultAvailable: result.value }), referenceIds } : null
  } catch { return null }
}

function validateEvidenceValue(value: unknown, seen: Set<object>, depth: number, budget: EvidenceBudget): boolean {
  const kind = typeof value
  if (value === null || kind === 'boolean') return true
  if (typeof value === 'string') { budget.characters += value.length; return value.length <= MAX_EVIDENCE_STRING && budget.characters <= MAX_EVIDENCE_CONTENT }
  if (kind === 'number') return Number.isFinite(value)
  if (kind !== 'object' || depth >= MAX_EVIDENCE_DEPTH || seen.has(value as object)) return false
  const object = value as object
  seen.add(object)
  try {
    budget.nodes += 1
    if (budget.nodes > MAX_EVIDENCE_NODES) return false
    const keys = Reflect.ownKeys(object)
    if (Array.isArray(value)) return value.length <= MAX_EVIDENCE_ARRAY && keys.every(key => typeof key === 'string' && (key === 'length' || /^\d+$/.test(key))) && keys.filter((key): key is string => key !== 'length').every(key => validateEvidenceValue((value as unknown as Record<string, unknown>)[key], seen, depth + 1, budget))
    return isPlainRecord(value) && keys.length <= MAX_EVIDENCE_ARRAY && keys.every(key => typeof key === 'string' && key.length <= MAX_EVIDENCE_STRING && SAFE_EVIDENCE_KEYS.has(key) && (OPAQUE_EVIDENCE_KEYS.has(key) || validateEvidenceValue((value as Record<string, unknown>)[key], seen, depth + 1, budget)))
  } catch { return false } finally { seen.delete(object) }
}

function readReferenceIds(root: Record<string, unknown>): string[] | null {
  const references: string[] = [], add = (value: unknown): boolean => { const id = safeStableId(value); if (!id) return false; if (!references.includes(id)) references.push(id); return references.length <= MAX_EVIDENCE_REFERENCES }
  for (const key of ['artifactId', 'evidenceId', 'jobId', 'referenceId']) if (key in root && !add(root[key])) return null
  for (const key of ['artifactRefs', 'evidenceIds', 'evidenceRefs', 'referenceIds', 'references', 'jobIds']) if (key in root && (!Array.isArray(root[key]) || root[key].length > MAX_EVIDENCE_ARRAY || !root[key].every(add))) return null
  if ('parts' in root) {
    if (!Array.isArray(root.parts) || root.parts.length > MAX_EVIDENCE_ARRAY) return null
    for (const part of root.parts) {
      if (!isPlainRecord(part) || typeof part.type !== 'string' || !SAFE_PART_TYPES.has(part.type)) return null
      if ((part.type === 'citation' && !add(part.evidenceId)) || ((part.type === 'artifact_card' || part.type === 'attachment_ref') && !add(part.artifactId))) return null
      if ((part.type === 'text' && typeof part.text !== 'string') || (part.type === 'job_table' && (!Array.isArray(part.jobIds) || !part.jobIds.every(add)))) return null
    }
  }
  for (const key of ['output', 'result', 'outputSummary']) if (key in root) {
    const nested = readOpaqueReferenceIds(root[key])
    if (!nested || !nested.every(add)) return null
  }
  return references
}

function readOpaqueReferenceIds(value: unknown): string[] | null {
  if (!isPlainRecord(value)) return []
  const references: string[] = [], add = (candidate: unknown): boolean => { const id = safeStableId(candidate); if (!id) return false; if (!references.includes(id)) references.push(id); return references.length <= MAX_EVIDENCE_REFERENCES }
  try {
    for (const key of ['artifactId', 'evidenceId', 'jobId', 'referenceId']) if (key in value && !add(value[key])) return null
    for (const key of ['artifactRefs', 'evidenceIds', 'evidenceRefs', 'referenceIds', 'references', 'jobIds']) if (key in value && (!Array.isArray(value[key]) || value[key].length > MAX_EVIDENCE_ARRAY || !value[key].every(add))) return null
    return references
  } catch { return null }
}

function optionalStableField(root: Record<string, unknown>, ...keys: string[]): { valid: boolean; value: string | null } {
  const allowNull = keys.includes('allowNull')
  for (const key of keys.filter(candidate => candidate !== 'allowNull')) if (key in root) { const value = root[key]; if (allowNull && value === null) return { valid: true, value: null }; const id = safeStableId(value); return { valid: id !== null, value: id } }
  return { valid: true, value: null }
}
function readOutputAvailability(root: Record<string, unknown>): { valid: boolean; value?: boolean } {
  if ('resultAvailable' in root) return typeof root.resultAvailable === 'boolean' ? { valid: true, value: root.resultAvailable } : { valid: false }
  if ('outputAvailable' in root) return typeof root.outputAvailable === 'boolean' ? { valid: true, value: root.outputAvailable } : { valid: false }
  return ['output', 'result', 'outputSummary'].some(key => key in root) ? { valid: true, value: true } : { valid: true }
}
function safeStableId(value: unknown): string | null { if (typeof value !== 'string') return null; const trimmed = value.trim(); return !trimmed || trimmed.length > MAX_EVIDENCE_STRING || SENSITIVE_ID.test(trimmed) || trimmed.includes('://') || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(trimmed) ? null : trimmed }
function safeToken(value: unknown): string | null { return typeof value === 'string' && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : null }
function isPlainRecord(value: unknown): value is Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false } }

export function statusLabel(status: string, t: (key: string) => string): string {
  if (status === 'queued' || status === 'retrying') return t('agent.queuedTasks')
  if (status === 'running' || status === 'in_progress' || status === 'started' || status === 'streaming') return t('agent.running')
  if (status.startsWith('waiting')) return t('agent.waiting')
  if (status === 'completed' || status === 'passed') return t('agent.done')
  if (status === 'failed' || status === 'error') return t('agent.errorTitle')
  if (status === 'interrupted' || status === 'cancelled') return t('agent.toolCancelled')
  if (status === 'paused') return t('agent.paused')
  return t('agent.unknownItem')
}
