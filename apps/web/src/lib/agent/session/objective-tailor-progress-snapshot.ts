import { OBJECTIVE_TAILOR_GRAPH_MAX_NODES, parseObjectiveTailorGraph, type ObjectiveTailorGraph } from '@jobcopilot/agent-protocol'
import { OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA, type ObjectiveTailorProgressHint } from './objective-tailor-progress-contract'

export type ObjectiveTailorProgressSnapshotNode = Readonly<{ key: string; taskId: string; templateId: string }>
export type ObjectiveTailorProgressSnapshot = Readonly<{
  marker: ObjectiveTailorGraph
  nodes: readonly ObjectiveTailorProgressSnapshotNode[]
}>

const SNAPSHOT_SCHEMA = 'agent-harness.v2.task-graph'
const BASE_NODE_KEYS = ['dependsOn', 'depth', 'goal', 'key', 'successCriteria', 'taskId', 'templateId', 'verificationDisposition'] as const

/** Reads only the exact persisted marked graph envelope; callers must not infer proof from this projection. */
export function parseObjectiveTailorProgressSnapshot(value: unknown): ObjectiveTailorProgressSnapshot | undefined {
  try {
    const row = record(value, ['nodes', 'objectiveTailor', 'schemaVersion'], ['rootSuccessCriteria'])
    const nodes = row && dense(row.nodes, OBJECTIVE_TAILOR_GRAPH_MAX_NODES)
    if (!row || row.schemaVersion !== SNAPSHOT_SCHEMA || !nodes) return undefined
    if (Object.hasOwn(row, 'rootSuccessCriteria') && !textList(row.rootSuccessCriteria, 8, 320, 1)) return undefined
    const marker = parseObjectiveTailorGraph(row.objectiveTailor, nodes)
    if (!marker || nodes.some(node => !validNode(node))
      || new Set(nodes.map(node => (node as Record<string, unknown>).key)).size !== nodes.length
      || new Set(nodes.map(node => (node as Record<string, unknown>).taskId)).size !== nodes.length) return undefined
    return { marker, nodes: nodes.map(node => {
      const item = node as Record<string, unknown>
      return { key: item.key as string, taskId: item.taskId as string, templateId: item.templateId as string }
    }) }
  } catch { return undefined }
}

export function objectiveTailorProgressHint(snapshot: ObjectiveTailorProgressSnapshot): ObjectiveTailorProgressHint {
  return { schemaVersion: OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA,
    sourceNodeCount: snapshot.marker.sourceNodeCount, slotCount: snapshot.marker.slots.length }
}

function validNode(value: unknown): boolean {
  const node = record(value, BASE_NODE_KEYS, ['registeredScoutEnvelope', 'verification'])
  if (!node || !identifier(node.key, 128) || !identifier(node.taskId, 128) || !identifier(node.templateId, 128)
    || !text(node.goal, 4_000) || !textList(node.successCriteria, 32, 1_000, 0)
    || !textList(node.dependsOn, 8, 128, 0) || !Number.isSafeInteger(node.depth) || Number(node.depth) < 1 || Number(node.depth) > 8) return false
  const isSource = node.templateId === 'scout' || node.templateId === 'analyst'
  if (!isSource && node.templateId !== 'cover_letter_writer' && node.templateId !== 'cover_letter_reviewer') return false
  if (isSource !== Object.hasOwn(node, 'verification') || (isSource ? node.verificationDisposition !== 'typed' : node.verificationDisposition !== 'specialized')) return false
  if (Object.hasOwn(node, 'verification') && !validVerification(node.verification, node.templateId as string)) return false
  if (Object.hasOwn(node, 'registeredScoutEnvelope') && (node.templateId !== 'scout' || !validScoutEnvelope(node.registeredScoutEnvelope))) return false
  return true
}

function validVerification(value: unknown, templateId: string): boolean {
  const contract = record(value, ['criteria', 'role', 'schemaVersion'], ['criteria', 'role', 'schemaVersion'])
  const criteria = contract && dense(contract.criteria, 8)
  const role = templateId === 'scout' ? 'scout' : templateId === 'analyst' ? 'analyst' : undefined
  return !!contract && !!criteria && criteria.length > 0 && contract.role === role
    && (contract.schemaVersion === 'agent-harness.v2.task-graph-verification.v1' || contract.schemaVersion === 'agent-harness.v2.task-graph-verification.v2')
    && criteria.every(value => {
      const criterion = record(value, ['check', 'id'], ['check', 'id'])
      return !!criterion && typeof criterion.id === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(criterion.id) && validCheck(criterion.check)
    })
}

function validCheck(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = safeRecord(value), kind = row?.kind
  if (!row || typeof kind !== 'string') return false
  const keys: Record<string, string[]> = {
    candidate_count_gte: ['kind', 'minimum'], candidate_location_in: ['kind', 'locations'], finding_count_gte: ['kind', 'minimum'],
    evidence_count_gte: ['kind', 'minimum'], all_candidates_have_evidence: ['kind', 'minimumItems'], all_findings_have_evidence: ['kind', 'minimumItems'],
    reported_score_gte: ['aggregation', 'kind', 'minimumFindings', 'minimumScore'], findings_from_scout_dependency: ['dependencyNodeKey', 'kind'],
    findings_cover_scout_candidates_gte: ['dependencyNodeKey', 'kind', 'minimumPercent'], findings_from_scout_union: ['dependencyNodeKeys', 'kind'],
    findings_cover_scout_candidate_union_gte: ['dependencyNodeKeys', 'kind', 'minimumPercent'], findings_cover_each_scout_candidates_gte: ['dependencyNodeKeys', 'kind', 'minimumPercent'],
  }
  if (!exact(row, keys[kind] ?? [])) return false
  if ('minimum' in row || 'minimumItems' in row || 'minimumFindings' in row) {
    for (const key of ['minimum', 'minimumItems', 'minimumFindings'] as const) if (key in row
      && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1 || Number(row[key]) > 10_000)) return false
  }
  if ('minimumScore' in row && (typeof row.minimumScore !== 'number' || !Number.isFinite(row.minimumScore) || row.minimumScore < 0 || row.minimumScore > 10)) return false
  if ('minimumPercent' in row && (typeof row.minimumPercent !== 'number' || !Number.isFinite(row.minimumPercent) || row.minimumPercent < 1 || row.minimumPercent > 100)) return false
  if ('aggregation' in row && row.aggregation !== 'any' && row.aggregation !== 'all') return false
  if ('locations' in row && !textList(row.locations, 32, 128, 1)) return false
  if ('dependencyNodeKey' in row && !identifier(row.dependencyNodeKey, 128)) return false
  if ('dependencyNodeKeys' in row && !textList(row.dependencyNodeKeys, 8, 128, 1)) return false
  return true
}

function validScoutEnvelope(value: unknown): boolean {
  const row = record(value, ['allowedActions', 'expectedOutputSchema', 'role', 'taskType'], ['allowedActions', 'expectedOutputSchema', 'role', 'taskType'])
  const output = row && record(row.expectedOutputSchema, ['role', 'schemaVersion'], ['role', 'schemaVersion'])
  return !!row && row.role === 'scout' && identifier(row.taskType, 128) && !!output && output.role === 'scout'
    && output.schemaVersion === 'agent-harness.v2.subagent.result' && textList(row.allowedActions, 32, 128, 0)
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  const row = safeRecord(value)
  if (!row) return undefined
  const keys = Reflect.ownKeys(row)
  return keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
    && required.every(key => Object.hasOwn(row, key)) ? row : undefined
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== 'string')) return undefined
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
  }
  return value as Record<string, unknown>
}

function exact(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(row)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

function dense(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string')) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result.push(descriptor.value)
  }
  return result
}

function identifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && value.trim() === value
}

function textList(value: unknown, maximum: number, textMaximum: number, minimum: number): value is string[] {
  const rows = dense(value, maximum)
  return !!rows && rows.length >= minimum && rows.every(item => typeof item === 'string' && item.length > 0 && item.length <= textMaximum && item.trim() === item)
}
