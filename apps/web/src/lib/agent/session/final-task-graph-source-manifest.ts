import { projectFinalAnswerDisplayContent, type FinalAnswerDisplayContent } from './final-answer-evidence-projection'

export const TASK_GRAPH_SOURCES_SCHEMA_VERSION = 'agent-harness.v2.task-graph-sources.v1' as const

export const TASK_GRAPH_SOURCE_ROLES = ['scout', 'analyst', 'writer', 'reviewer', 'prepare', 'unsupported'] as const
export const TASK_GRAPH_SOURCE_TASK_STATUSES = ['queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed'] as const
export const TASK_GRAPH_SOURCE_RESULT_STATES = ['valid', 'missing', 'invalid', 'unsupported_role', 'not_terminal'] as const
export const TASK_GRAPH_SOURCE_ROLE_RESULT_STATUSES = ['completed', 'partial'] as const

export type TaskGraphSourceRole = typeof TASK_GRAPH_SOURCE_ROLES[number]
export type TaskGraphSourceTaskStatus = typeof TASK_GRAPH_SOURCE_TASK_STATUSES[number]
export type TaskGraphSourceResultState = typeof TASK_GRAPH_SOURCE_RESULT_STATES[number]
export type TaskGraphSourceRoleResultStatus = typeof TASK_GRAPH_SOURCE_ROLE_RESULT_STATUSES[number]
export type FinalTaskGraphSource = Readonly<{
  sourceKey: string
  nodeIndex: number
  role: TaskGraphSourceRole
  taskStatus: TaskGraphSourceTaskStatus
  resultState: TaskGraphSourceResultState
  roleResultStatus?: TaskGraphSourceRoleResultStatus
}>
export type FinalTaskGraphSourceManifest = Readonly<{
  schemaVersion: typeof TASK_GRAPH_SOURCES_SCHEMA_VERSION
  graphRevision: number
  sources: readonly FinalTaskGraphSource[]
}>

export type FinalAnswerWithTaskGraphSources = FinalAnswerDisplayContent & Readonly<{ taskGraphSources?: FinalTaskGraphSourceManifest }>

/** Checks Worker-generated item-bound keys with browser APIs; missing crypto fails closed. */
export async function isCanonicalTaskGraphSourceManifestWeb(finalItemId: string, manifest: FinalTaskGraphSourceManifest): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle || typeof globalThis.btoa !== 'function') return false
  try {
    const encoder = new TextEncoder()
    for (const source of manifest.sources) {
      const input = `taskGraphSource:v1\0${finalItemId}\0${manifest.graphRevision}\0${source.nodeIndex}`
      const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(input)))
      let binary = ''
      for (const byte of digest) binary += String.fromCharCode(byte)
      const key = `src_${globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
      if (source.sourceKey !== key) return false
    }
    return true
  } catch { return false }
}

const TERMINAL = new Set<TaskGraphSourceTaskStatus>(['completed', 'failed', 'interrupted', 'cancelled', 'closed'])
const NONTERMINAL = new Set<TaskGraphSourceTaskStatus>(['queued', 'running', 'retrying', 'waiting', 'waiting_for_user'])
const SOURCE_KEY = /^src_[A-Za-z0-9_-]{43}$/

/** Projects the versioned public sibling manifest; it deliberately contains no record IDs or prose. */
export function parseFinalTaskGraphSourceManifest(value: unknown): FinalTaskGraphSourceManifest | null {
  const row = record(value)
  if (!row || !exactKeys(row, ['graphRevision', 'schemaVersion', 'sources'])
    || row.schemaVersion !== TASK_GRAPH_SOURCES_SCHEMA_VERSION || !integer(row.graphRevision, 1, Number.MAX_SAFE_INTEGER)
    || !dense(row.sources, 1, 8)) return null

  const sources: FinalTaskGraphSource[] = []
  const keys = new Set<string>(), indexes = new Set<number>()
  let previousIndex = -1
  for (const value of row.sources) {
    const source = record(value)
    if (!source) return null
    const hasResultStatus = Object.hasOwn(source, 'roleResultStatus')
    const expected = hasResultStatus
      ? ['nodeIndex', 'resultState', 'role', 'roleResultStatus', 'sourceKey', 'taskStatus']
      : ['nodeIndex', 'resultState', 'role', 'sourceKey', 'taskStatus']
    if (!exactKeys(source, expected) || typeof source.sourceKey !== 'string' || !SOURCE_KEY.test(source.sourceKey)
      || !integer(source.nodeIndex, 0, 7) || source.nodeIndex <= previousIndex || indexes.has(source.nodeIndex)
      || keys.has(source.sourceKey) || !oneOf(source.role, TASK_GRAPH_SOURCE_ROLES)
      || !oneOf(source.taskStatus, TASK_GRAPH_SOURCE_TASK_STATUSES) || !oneOf(source.resultState, TASK_GRAPH_SOURCE_RESULT_STATES)
      || hasResultStatus && !oneOf(source.roleResultStatus, TASK_GRAPH_SOURCE_ROLE_RESULT_STATUSES)
      || !coherentOutcome(source as unknown as FinalTaskGraphSource)) return null
    previousIndex = source.nodeIndex
    indexes.add(source.nodeIndex)
    keys.add(source.sourceKey)
    sources.push({ sourceKey: source.sourceKey, nodeIndex: source.nodeIndex, role: source.role as TaskGraphSourceRole,
      taskStatus: source.taskStatus as TaskGraphSourceTaskStatus, resultState: source.resultState as TaskGraphSourceResultState,
      ...(hasResultStatus ? { roleResultStatus: source.roleResultStatus as TaskGraphSourceRoleResultStatus } : {}) })
  }
  return { schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: row.graphRevision, sources }
}

/** Keeps the strict final-answer DTO and adds only the bounded public sidecar. */
export function projectFinalAnswerWithTaskGraphSources(value: unknown): FinalAnswerWithTaskGraphSources | null {
  const row = record(value)
  if (!row || Object.keys(row).some(key => !['text', 'summary', 'answerEvidence', 'taskGraphSources'].includes(key))) return null
  const answer = projectFinalAnswerDisplayContent({ text: row.text,
    ...(Object.hasOwn(row, 'summary') ? { summary: row.summary } : {}),
    ...(Object.hasOwn(row, 'answerEvidence') ? { answerEvidence: row.answerEvidence } : {}) })
  if (!answer) return null
  const taskGraphSources = parseFinalTaskGraphSourceManifest(row.taskGraphSources)
  return { ...answer, ...(taskGraphSources ? { taskGraphSources } : {}) }
}

function coherentOutcome(source: FinalTaskGraphSource): boolean {
  if (source.resultState === 'valid') return source.role !== 'unsupported' && TERMINAL.has(source.taskStatus)
    && source.roleResultStatus !== undefined
    && ((source.role === 'writer' || source.role === 'reviewer') ? source.roleResultStatus === 'completed' : true)
  if (source.roleResultStatus !== undefined) return false
  if (source.resultState === 'unsupported_role') return source.role === 'unsupported'
  if (source.role === 'unsupported') return false
  return source.resultState === 'not_terminal' ? NONTERMINAL.has(source.taskStatus) : TERMINAL.has(source.taskStatus)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown> : null
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  } catch { return false }
}

function dense(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false
  try { return Reflect.ownKeys(value).length === value.length + 1 && value.every((_, index) => Object.hasOwn(value, index)) }
  catch { return false }
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
