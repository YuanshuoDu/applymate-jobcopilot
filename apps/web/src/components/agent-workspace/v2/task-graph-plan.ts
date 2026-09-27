import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary } from './task-tree-projection'
import {
  parseTaskGraphSnapshot,
  TASK_GRAPH_MAX_IDENTIFIER_LENGTH,
} from './task-graph-plan-snapshot'
import type { TaskGraphSnapshotNode } from './task-graph-plan-snapshot'
import { latestTaskGraphItem } from './task-graph-plan-query'

export { parseTaskGraphSnapshot } from './task-graph-plan-snapshot'

const MAX_DISPLAY_TEXT_LENGTH = 240
const GOAL_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const GOAL_URL_PATTERN = /https?:\/\/[^\s<>]+/gi
const GOAL_PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{3,}/g

const TASK_STATUSES = new Set([
  'queued', 'running', 'retrying', 'waiting', 'waiting_for_user',
  'completed', 'failed', 'interrupted', 'cancelled', 'closed',
] as const)
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'closed'])
const BLOCKING_STATUSES = new Set(['failed', 'interrupted', 'cancelled', 'closed'])

export type TaskGraphPlanStatus =
  | 'queued' | 'running' | 'retrying' | 'waiting' | 'waiting_for_user'
  | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'closed'
export type TaskGraphPlanReadiness = 'ready' | 'waiting_for_dependencies' | 'blocked_dependency' | 'active' | 'terminal' | 'unavailable'
export type TaskGraphPlanDependency = Readonly<{ key: string; label: string; status: TaskGraphPlanStatus | null }>
export type TaskGraphEvidencePreview = Readonly<{
  role: 'scout' | 'analyst'
  summary: string
  itemCount: number
  evidence: readonly Readonly<{ kind: 'job' | 'persona' | 'resume' | 'source'; source: string; reference: string | null }>[]
}>
export type TaskGraphPlanNode = Readonly<{
  key: string
  goal: string
  status: TaskGraphPlanStatus | null
  resultAvailable: boolean
  evidencePreview: TaskGraphEvidencePreview | null
  readiness: TaskGraphPlanReadiness
  dependencies: readonly TaskGraphPlanDependency[]
}>
export type TaskGraphPlan = Readonly<{
  revision: number
  goal: string | null
  nodes: readonly TaskGraphPlanNode[]
}>

export function projectCurrentTaskGraph(
  items: readonly TimelineItem[],
  scopedTasks: readonly SupervisorTaskSummary[],
  sessionId: string,
): TaskGraphPlan | null {
  if (!sessionId.trim()) return null
  const item = latestTaskGraphItem(items, sessionId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!item || !snapshot || snapshot.nodes.length === 0 || !Number.isSafeInteger(item.revision) || item.revision < 1) return null

  const tasksById = new Map<string, ScopedTask>()
  for (const value of scopedTasks as readonly unknown[]) {
    const task = readScopedTask(value, sessionId)
    if (!task) continue
    const existing = tasksById.get(task.id)
    // Only a strictly newer timestamp can replace a selected DTO. Keep the
    // first row when either timestamp is missing or the timestamps tie.
    if (!existing || (Number.isFinite(task.updatedAt) && Number.isFinite(existing.updatedAt) && task.updatedAt > existing.updatedAt)) {
      tasksById.set(task.id, task)
    }
  }

  const nodesByKey = new Map(snapshot.nodes.map(node => [node.key, node] as const))
  const taskByKey = new Map(snapshot.nodes.map(node => [node.key, tasksById.get(node.taskId)] as const))
  const statusByKey = new Map(snapshot.nodes.map(node => [node.key, parseTaskStatus(taskByKey.get(node.key)?.status)] as const))
  const blockedMemo = new Map<string, boolean>()
  const rootTask = item.taskId ? tasksById.get(item.taskId) : undefined
  const nodes = snapshot.nodes.map(node => {
    const task = taskByKey.get(node.key)
    const status = task?.status ?? null
    const dependencies = node.dependsOn.map(key => {
      const dependency = nodesByKey.get(key)!
      const dependencyTask = taskByKey.get(key)
      return {
        key,
        label: dependencyTask?.goal || displayGoalText(dependency.goal, MAX_DISPLAY_TEXT_LENGTH),
        status: statusByKey.get(key) ?? null,
      }
    })
    return {
      key: node.key,
      goal: task?.goal || displayGoalText(node.goal, MAX_DISPLAY_TEXT_LENGTH),
      status,
      resultAvailable: task?.hasResult ?? false,
      evidencePreview: task?.evidencePreview ?? null,
      readiness: deriveReadiness(node, status, statusByKey, nodesByKey, blockedMemo),
      dependencies,
    }
  })
  return { revision: item.revision, goal: rootTask?.goal || null, nodes }
}

function deriveReadiness(
  node: TaskGraphSnapshotNode,
  status: TaskGraphPlanStatus | null,
  statusByKey: ReadonlyMap<string, TaskGraphPlanStatus | null>,
  nodesByKey: ReadonlyMap<string, TaskGraphSnapshotNode>,
  blockedMemo: Map<string, boolean>,
): TaskGraphPlanReadiness {
  if (!status) return 'unavailable'
  if (TERMINAL_STATUSES.has(status)) return 'terminal'
  if (status !== 'queued' && status !== 'waiting') return 'active'
  if (isBlockedByDependency(node, statusByKey, nodesByKey, blockedMemo)) return 'blocked_dependency'
  const dependenciesCompleted = node.dependsOn.every(key => statusByKey.get(key) === 'completed')
  if (!dependenciesCompleted) return 'waiting_for_dependencies'
  return status === 'queued' ? 'ready' : 'active'
}

function isBlockedByDependency(
  node: TaskGraphSnapshotNode,
  statusByKey: ReadonlyMap<string, TaskGraphPlanStatus | null>,
  nodesByKey: ReadonlyMap<string, TaskGraphSnapshotNode>,
  memo: Map<string, boolean>,
): boolean {
  const known = memo.get(node.key)
  if (known !== undefined) return known
  const blocked = node.dependsOn.some(key => {
    const status = statusByKey.get(key)
    const dependency = nodesByKey.get(key)
    return !dependency || (status !== null && status !== undefined && BLOCKING_STATUSES.has(status))
      || isBlockedByDependency(dependency, statusByKey, nodesByKey, memo)
  })
  memo.set(node.key, blocked)
  return blocked
}

type ScopedTask = Readonly<{
  id: string
  goal: string
  status: TaskGraphPlanStatus | null
  hasResult: boolean
  evidencePreview: TaskGraphEvidencePreview | null
  updatedAt: number
}>

function readScopedTask(value: unknown, sessionId: string): ScopedTask | null {
  try {
    if (!isPlainRecord(value) || value.sessionId !== sessionId) return null
    const id = boundedText(value.id, TASK_GRAPH_MAX_IDENTIFIER_LENGTH)
    if (!id) return null
    const status = parseTaskStatus(value.status)
    const hasResult = value.hasResult === true
    return {
      id,
      goal: displayGoalText(value.goal, MAX_DISPLAY_TEXT_LENGTH),
      status,
      // The Workbench only needs an availability bit. Never project task result payloads here.
      hasResult,
      evidencePreview: status === 'completed' && hasResult ? readEvidencePreview(value.structuredEvidencePreview, value.role) : null,
      updatedAt: timestamp(value.updatedAt),
    }
  } catch {
    return null
  }
}

function readEvidencePreview(value: unknown, expectedRole: unknown): TaskGraphEvidencePreview | null {
  try {
    if (!isPlainRecord(value) || (expectedRole !== 'scout' && expectedRole !== 'analyst') || value.role !== expectedRole
      || typeof value.summary !== 'string' || !safePreviewText(value.summary, 240)
      || !Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 0 || (value.itemCount as number) > 50
      || !Array.isArray(value.evidence) || value.evidence.length > 5) return null
    const evidence: TaskGraphEvidencePreview['evidence'][number][] = []
    for (const raw of value.evidence) {
      if (!isPlainRecord(raw) || !exactPreviewKeys(raw, ['kind', 'source', 'reference'])
        || !['job', 'persona', 'resume', 'source'].includes(String(raw.kind))
        || typeof raw.source !== 'string' || !safePreviewText(raw.source, 128)
        || (raw.reference !== null && (typeof raw.reference !== 'string' || !safePreviewReference(raw.reference)))) return null
      evidence.push({ kind: raw.kind as TaskGraphEvidencePreview['evidence'][number]['kind'], source: raw.source, reference: raw.reference as string | null })
    }
    return { role: expectedRole, summary: value.summary, itemCount: value.itemCount as number, evidence }
  } catch {
    return null
  }
}

function exactPreviewKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function safePreviewText(value: string, maximum: number): boolean {
  return value.trim().length > 0 && value.length <= maximum
    && !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    && !/https?:\/\/[^\s<>]+/i.test(value)
    && !/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{3,}/.test(value)
}

function safePreviewReference(value: string): boolean {
  return safePreviewText(value, 128) && !/^https?:\/\//i.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null
}

function displayGoalText(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.trim().length > 0
    ? redactUnsafeGoalText(value.trim()).slice(0, maximum)
    : ''
}

function redactUnsafeGoalText(value: string): string {
  return value
    .replace(GOAL_EMAIL_PATTERN, '[redacted]')
    .replace(GOAL_URL_PATTERN, url => {
      const punctuation = /[.,!?;:)]+$/.exec(url)?.[0] ?? ''
      return `[redacted]${punctuation}`
    })
    .replace(GOAL_PHONE_PATTERN, '[redacted]')
}

function parseTaskStatus(value: unknown): TaskGraphPlanStatus | null {
  if (value === 'passed') return 'completed'
  return typeof value === 'string' && TASK_STATUSES.has(value as TaskGraphPlanStatus) ? value as TaskGraphPlanStatus : null
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 128) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
