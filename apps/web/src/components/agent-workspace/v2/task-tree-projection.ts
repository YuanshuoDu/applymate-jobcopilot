import type { TimelineItem } from './timeline-reducer'
import type { TaskTreeNode } from './types'

export interface SupervisorTurnSummary {
  readonly id: string
  readonly sessionId: string
  readonly source: string
  readonly goal: string
  readonly status: string
  readonly revision: number
  readonly activeStepId: string | null
  readonly finalItemId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface SupervisorTaskSummary {
  readonly id: string
  readonly sessionId: string
  readonly turnId?: string | null
  readonly parentTaskId?: string | null
  readonly role: string
  readonly taskType: string
  readonly status: string
  readonly goal: string
  readonly hasResult: boolean
  readonly failureReason?: string | null
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface SupervisorTreeInput {
  readonly turns: readonly SupervisorTurnSummary[]
  readonly items: readonly TimelineItem[]
  readonly tasks?: readonly SupervisorTaskSummary[]
  readonly labels?: SupervisorTreeLabels
}

export interface SupervisorTreeLabels {
  readonly task: string
  readonly step: string
  readonly tool: string
}

const DEFAULT_LABELS: SupervisorTreeLabels = { task: 'Task', step: 'Step', tool: 'Tool' }

/** Projects authoritative turns plus timeline evidence into a read-only tree. */
export function projectSupervisorTree({ turns, items, tasks = [], labels = DEFAULT_LABELS }: SupervisorTreeInput): TaskTreeNode[] {
  const itemsByTurn = groupBy(items, item => item.turnId)
  const tasksByTurn = groupBy(tasks, task => task.turnId ?? '')
  const turnNodes = [...turns].sort(compareCreated).map(turn => {
    const turnItems = itemsByTurn.get(turn.id) ?? []
    const children = projectEvidence(turnItems, turn.activeStepId, turn.status, labels)
    const taskChildren = projectTaskTree(tasksByTurn.get(turn.id) ?? [], labels, turnItems)
    return {
      id: `turn:${turn.id}`,
      kind: 'turn' as const,
      label: displayGoal(turn.goal) || labels.task,
      status: turn.status,
      itemId: turn.finalItemId ?? latestItem(turnItems)?.id,
      children: [...taskChildren, ...children],
    }
  })

  const orphanTasks = tasks.filter(task => !task.turnId || !turns.some(turn => turn.id === task.turnId))
  const orphanItems = items.filter(item => !turns.some(turn => turn.id === item.turnId))
  if (orphanItems.length) {
    turnNodes.push({
      id: 'turn:orphan-items', kind: 'turn', label: labels.task, status: 'unknown',
      itemId: latestItem(orphanItems)?.id, children: projectEvidence(orphanItems, null, 'unknown', labels),
    })
  }
  return [...turnNodes, ...projectTaskTree(orphanTasks, labels, orphanItems)]
}

function projectEvidence(items: readonly TimelineItem[], activeStepId: string | null, turnStatus: string, labels: SupervisorTreeLabels): TaskTreeNode[] {
  const stepGroups = new Map<string, TimelineItem[]>()
  const turnItems: TimelineItem[] = []
  for (const item of items) {
    if (!item.stepId) turnItems.push(item)
    else stepGroups.set(item.stepId, [...(stepGroups.get(item.stepId) ?? []), item])
  }
  if (activeStepId && !stepGroups.has(activeStepId)) stepGroups.set(activeStepId, [])
  const steps = [...stepGroups.entries()].sort((left, right) => compareGroups(left[1], right[1])).map(([stepId, stepItems]) => ({
    id: `step:${stepId}`,
    kind: 'step' as const,
    label: stepLabel(stepItems, labels.step),
    status: stepId === activeStepId ? turnStatus : latestItem(stepItems)?.status ?? 'queued',
    itemId: latestItem(stepItems)?.id,
    children: projectTools(stepItems, labels.tool),
  }))
  return [...steps, ...projectTools(turnItems, labels.tool)]
}

function projectTools(items: readonly TimelineItem[], fallbackLabel: string): TaskTreeNode[] {
  const groups = new Map<string, TimelineItem[]>()
  for (const item of items) {
    if (item.type !== 'tool_call' && item.type !== 'tool_result') continue
    const key = toolCallId(item) ?? item.id
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()].sort((left, right) => compareCreated(left[1][0], right[1][0])).map(([key, group]) => {
    const latest = latestItem(group)
    const resultAvailable = group.some(item => item.type === 'tool_result' || record(item.content).outputAvailable === true)
    return {
      id: `tool:${key}`,
      kind: 'tool' as const,
      label: toolLabel(group, fallbackLabel),
      status: latest?.status ?? 'queued',
      resultAvailable,
      itemId: latest?.id,
    }
  })
}

function projectTask(task: SupervisorTaskSummary, fallbackLabel: string, items: readonly TimelineItem[]): TaskTreeNode {
  const evidence = latestItem(items.filter(item => item.taskId === task.id))
  return {
    id: `task:${task.id}`,
    kind: 'task',
    label: displayGoal(task.goal) || task.role || task.taskType || fallbackLabel,
    status: task.status,
    itemId: evidence?.id,
    detail: task.failureReason ?? undefined,
    resultAvailable: task.hasResult || evidence?.type === 'tool_result',
  }
}

function projectTaskTree(tasks: readonly SupervisorTaskSummary[], labels: SupervisorTreeLabels, items: readonly TimelineItem[]): TaskTreeNode[] {
  const nodes = new Map(tasks.map(task => [task.id, projectTask(task, labels.task, items)]))
  const children = new Map<string, TaskTreeNode[]>()
  const roots: TaskTreeNode[] = []
  for (const task of tasks) {
    const node = nodes.get(task.id)
    if (!node) continue
    const parentId = task.parentTaskId
    if (parentId && nodes.has(parentId)) children.set(parentId, [...(children.get(parentId) ?? []), node])
    else roots.push(node)
  }
  const rootsToRender = roots.length > 0 ? roots : tasks.slice(0, 1).map(task => nodes.get(task.id)).filter((node): node is TaskTreeNode => Boolean(node))
  const projected = rootsToRender.map(node => attachTaskChildren(node, children, new Set([node.id.slice(5)])))
  const included = new Set<string>()
  const collect = (entries: readonly TaskTreeNode[]) => entries.forEach(entry => { included.add(entry.id.slice(5)); collect(entry.children ?? []) })
  collect(projected)
  for (const task of tasks) {
    if (included.has(task.id)) continue
    const node = nodes.get(task.id)
    if (node) {
      projected.push(attachTaskChildren(node, children, new Set([node.id.slice(5)])))
      collect([projected[projected.length - 1]])
    }
  }
  return projected
}

function attachTaskChildren(node: TaskTreeNode, children: Map<string, TaskTreeNode[]>, path: Set<string>): TaskTreeNode {
  const taskId = node.id.startsWith('task:') ? node.id.slice(5) : ''
  const nested = (children.get(taskId) ?? []).filter(child => !path.has(child.id.slice(5)))
  return nested.length
    ? { ...node, children: nested.map(child => attachTaskChildren(child, children, new Set([...path, child.id.slice(5)]))) }
    : node
}

function displayGoal(value: string): string { return value.trim() }
function stepLabel(items: readonly TimelineItem[], fallbackLabel: string): string {
  for (const item of items) {
    const content = record(item.content)
    for (const key of ['title', 'stepName', 'name']) if (typeof content[key] === 'string' && content[key].trim()) return content[key] as string
  }
  return fallbackLabel
}
function toolLabel(items: readonly TimelineItem[], fallbackLabel: string): string {
  for (const item of items) {
    const content = record(item.content)
    for (const key of ['toolName', 'name']) if (typeof content[key] === 'string' && content[key].trim()) return content[key] as string
  }
  return fallbackLabel
}
function toolCallId(item: TimelineItem): string | null {
  const value = record(item.content).toolCallId
  return typeof value === 'string' && value.trim() ? value : null
}
function latestItem(items: readonly TimelineItem[]): TimelineItem | undefined { return [...items].sort(compareCreated).at(-1) }
function compareGroups(left: readonly TimelineItem[], right: readonly TimelineItem[]): number {
  const leftItem = left[0]
  const rightItem = right[0]
  if (leftItem && rightItem) return compareCreated(leftItem, rightItem)
  if (leftItem) return -1
  if (rightItem) return 1
  return 0
}
function compareCreated(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  const byDate = left.createdAt.localeCompare(right.createdAt)
  return byDate || left.id.localeCompare(right.id)
}
function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) { const groupKey = key(value); groups.set(groupKey, [...(groups.get(groupKey) ?? []), value]) }
  return groups
}
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
