import { createHash } from 'node:crypto'
import {
  parseTaskGraphSnapshot,
  projectPlanLedger,
  projectTaskGraphVerificationSummary,
  type TaskGraphVerificationDisplayNode,
} from '@jobcopilot/agent-protocol'

import {
  parseFinalTaskGraphSourceManifest,
  TASK_GRAPH_SOURCE_ROLES,
  TASK_GRAPH_SOURCE_TASK_STATUSES,
  type FinalTaskGraphSource,
  type FinalTaskGraphSourceManifest,
  type TaskGraphSourceRole,
  type TaskGraphSourceResultState,
  type TaskGraphSourceRoleResultStatus,
  type TaskGraphSourceTaskStatus,
} from './final-task-graph-source-manifest'

export interface FinalTaskGraphSourceDetail {
  readonly goal: string
  readonly role: TaskGraphSourceRole
  readonly taskStatus: TaskGraphSourceTaskStatus
  readonly resultState: TaskGraphSourceResultState
  readonly roleResultStatus?: TaskGraphSourceRoleResultStatus
  readonly verification: TaskGraphVerificationDisplayNode
}

export function canonicalTaskGraphSourceKey(finalItemId: string, graphRevision: number, nodeIndex: number): string {
  const input = `taskGraphSource:v1\0${finalItemId}\0${graphRevision}\0${nodeIndex}`
  return `src_${createHash('sha256').update(input, 'utf8').digest('base64url')}`
}

export function canonicalTaskGraphItemId(rootTaskId: string): string {
  return `task-graph-${createHash('sha256').update(rootTaskId, 'utf8').digest('hex')}`
}

export function isCanonicalTaskGraphSourceManifest(finalItemId: string, manifest: FinalTaskGraphSourceManifest): boolean {
  return manifest.sources.every(source => source.sourceKey === canonicalTaskGraphSourceKey(finalItemId, manifest.graphRevision, source.nodeIndex))
}

export function projectFinalAnswerTaskGraphSourceContent(finalItemId: string, phase: unknown, status: unknown,
  answerText: string, summary: string | undefined, answerEvidence: unknown, rawContent: unknown): Record<string, unknown> {
  const manifest = phase === 'final_answer' && status === 'completed'
    ? parseFinalTaskGraphSourceManifest(record(rawContent)?.taskGraphSources) : null
  const taskGraphSources = manifest && isCanonicalTaskGraphSourceManifest(finalItemId, manifest) ? manifest : undefined
  return { text: answerText, ...(summary ? { summary } : {}), ...(answerEvidence ? { answerEvidence } : {}),
    ...(taskGraphSources ? { taskGraphSources } : {}) }
}

export function projectFinalTaskGraphSourceDetail(input: {
  readonly userId: string
  readonly sessionId: string
  readonly finalItemId: string
  readonly sourceKey: string
  readonly session: unknown
  readonly finalItem: unknown
  readonly turn: unknown
  readonly graphRows: readonly unknown[]
  readonly taskRows: readonly unknown[]
}): FinalTaskGraphSourceDetail | null {
  const session = record(input.session), finalItem = record(input.finalItem), turn = record(input.turn)
  if (!session || session.id !== input.sessionId || session.userId !== input.userId || !finalItem || !turn
    || finalItem.id !== input.finalItemId || finalItem.sessionId !== input.sessionId || finalItem.type !== 'agent_message'
    || finalItem.status !== 'completed' || finalItem.phase !== 'final_answer' || !boundedId(finalItem.turnId)
    || !boundedId(finalItem.taskId) || turn.id !== finalItem.turnId || turn.sessionId !== input.sessionId
    || turn.userId !== input.userId || turn.status !== 'completed' || turn.rootTaskId !== finalItem.taskId) return null

  const content = record(finalItem.content)
  const manifest = content ? parseFinalTaskGraphSourceManifest(content.taskGraphSources) : null
  const sources = manifest?.sources.filter(source => source.sourceKey === input.sourceKey) ?? []
  if (!manifest || sources.length !== 1 || canonicalTaskGraphSourceKey(input.finalItemId, manifest.graphRevision, sources[0]!.nodeIndex) !== input.sourceKey) return null
  const graphRows = input.graphRows.map(record)
  if (graphRows.length !== 1 || !graphRows[0]) return null
  const graph = graphRows[0]
  if (graph.id !== canonicalTaskGraphItemId(turn.rootTaskId as string) || graph.sessionId !== input.sessionId
    || graph.turnId !== finalItem.turnId || graph.taskId !== turn.rootTaskId
    || graph.type !== 'task_graph' || graph.revision !== manifest.graphRevision) return null
  const snapshot = parseTaskGraphSnapshot(graph.content)
  if (!snapshot || snapshot.nodes.length < 1 || snapshot.nodes.length > 8) return null
  const taskIds = [turn.rootTaskId as string, ...snapshot.nodes.map(node => node.taskId)]
  if (new Set(taskIds).size !== taskIds.length || taskIds.some(id => !boundedId(id))) return null

  const rows = input.taskRows.map(record)
  if (rows.length !== taskIds.length || rows.some(row => !row || !taskIds.includes(String(row.id)))) return null
  const taskById = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (!row || !boundedId(row.id) || taskById.has(row.id) || row.sessionId !== input.sessionId
      || row.turnId !== finalItem.turnId || row.rootTaskId !== turn.rootTaskId
      || typeof row.role !== 'string' || typeof row.taskType !== 'string'
      || !oneOf(row.status, TASK_GRAPH_SOURCE_TASK_STATUSES)) return null
    taskById.set(row.id, row)
  }
  if (taskIds.some(id => !taskById.has(id))) return null
  const root = taskById.get(turn.rootTaskId as string)
  if (!root || root.parentTaskId !== null || root.role !== 'orchestrator' || root.taskType !== 'root') return null
  for (const id of taskIds.slice(1)) {
    const task = taskById.get(id)!
    if (task.parentTaskId !== turn.rootTaskId) return null
  }

  if (!isCanonicalTaskGraphSourceManifest(input.finalItemId, manifest)) return null
  const businessNodes = snapshot.nodes.flatMap((node, nodeIndex) => {
    const task = taskById.get(node.taskId)!
    return task.role === 'auditor' && task.taskType === 'native_verification' ? [] : [{ node, nodeIndex, task }]
  })
  if (manifest.sources.length !== businessNodes.length) return null
  for (const [index, member] of businessNodes.entries()) {
    const source = manifest.sources[index]!
    if (source.nodeIndex !== member.nodeIndex || source.taskStatus !== member.task.status || !sourceRoleMatches(member.task, source)
      || source.resultState === 'valid' && !roleResultMatches(member.task.result, source)) return null
  }

  const selectedSource = sources[0]!
  const node = snapshot.nodes[selectedSource.nodeIndex]
  const selectedTask = node ? taskById.get(node.taskId) : undefined
  if (!node || !selectedTask) return null

  const scopedRows = rows as Record<string, unknown>[]
  const publicTasks = scopedRows.map(row => ({
    id: row.id, sessionId: row.sessionId, turnId: row.turnId, rootTaskId: row.rootTaskId,
    parentTaskId: row.parentTaskId, role: row.role, taskType: row.taskType, status: row.status,
    goal: row.goal, result: row.result, hasResult: row.result !== null && row.result !== undefined, updatedAt: row.updatedAt,
  }))
  const plan = projectPlanLedger({ sessionId: input.sessionId, revision: manifest.graphRevision,
    rootTaskId: turn.rootTaskId, graph: graph.content, tasks: publicTasks })
  const goal = plan?.nodes[selectedSource.nodeIndex]?.goal
  if (!goal) return null
  const verification = plan ? projectTaskGraphVerificationSummary({ sessionId: input.sessionId,
    turnId: finalItem.turnId as string, rootTaskId: turn.rootTaskId as string, revision: manifest.graphRevision,
    graph: graph.content, tasks: scopedRows,
    digestCanonicalJson: canonicalJson => createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
  }, plan)?.nodes[selectedSource.nodeIndex] : undefined

  return {
    goal,
    role: selectedSource.role,
    taskStatus: selectedSource.taskStatus,
    resultState: selectedSource.resultState,
    ...(selectedSource.roleResultStatus ? { roleResultStatus: selectedSource.roleResultStatus } : {}),
    verification: verification ?? { status: 'unavailable' },
  }
}

export function parseTaskGraphSourcesFromFinalContent(value: unknown): FinalTaskGraphSourceManifest | null {
  const content = record(value)
  return content ? parseFinalTaskGraphSourceManifest(content.taskGraphSources) : null
}

function sourceRoleMatches(task: Record<string, unknown>, source: FinalTaskGraphSource): boolean {
  if (source.role !== 'unsupported') return task.role === source.role
  return typeof task.role === 'string' && !oneOf(task.role, TASK_GRAPH_SOURCE_ROLES.slice(0, -1))
    && !(task.role === 'auditor' && task.taskType === 'native_verification')
}

function roleResultMatches(value: unknown, source: FinalTaskGraphSource): boolean {
  const envelope = parseRecord(value)
  const result = envelope && record(envelope.structuredResult)
  return !!result && result.role === source.role && result.status === source.roleResultStatus
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value) as unknown) } catch { return null }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
