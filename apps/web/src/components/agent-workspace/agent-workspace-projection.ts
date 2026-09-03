export interface WorkspaceTaskInput {
  id: string
  parentTaskId?: string | null
  role: string
  taskType: string
  status: string
  goal?: string
  confidence?: number | null
  failureReason?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface WorkspaceTaskNode {
  task: WorkspaceTaskInput
  children: WorkspaceTaskNode[]
  orphaned: boolean
}

function taskOrder(left: WorkspaceTaskInput, right: WorkspaceTaskInput): number {
  const created = (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
  return created || left.id.localeCompare(right.id)
}

function safeParent(task: WorkspaceTaskInput, byId: ReadonlyMap<string, WorkspaceTaskInput>): string | null {
  const parentId = task.parentTaskId ?? null
  if (!parentId || parentId === task.id || !byId.has(parentId)) return null
  const visited = new Set([task.id])
  let current: string | null = parentId
  while (current) {
    if (visited.has(current)) return null
    visited.add(current)
    current = byId.get(current)?.parentTaskId ?? null
  }
  return parentId
}

/** Builds a deterministic tree without mutating API data; bad parents become visible roots. */
export function projectTaskTree(tasks: readonly WorkspaceTaskInput[]): WorkspaceTaskNode[] {
  const byId = new Map<string, WorkspaceTaskInput>()
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task)
  const nodes = new Map<string, WorkspaceTaskNode>()
  for (const task of byId.values()) nodes.set(task.id, { task, children: [], orphaned: false })
  const roots: WorkspaceTaskNode[] = []
  for (const node of nodes.values()) {
    const parentId = safeParent(node.task, byId)
    if (!parentId) {
      node.orphaned = Boolean(node.task.parentTaskId)
      roots.push(node)
      continue
    }
    nodes.get(parentId)?.children.push(node)
  }
  const sort = (items: WorkspaceTaskNode[]) => {
    items.sort((left, right) => taskOrder(left.task, right.task))
    items.forEach(item => sort(item.children))
  }
  sort(roots)
  return roots
}

export type ApprovalViewState = 'pending' | 'answered' | 'stale' | 'expired' | 'unavailable'

export interface ApprovalScopeView {
  sessionId: string | null
  turnId: string | null
  jobId: string | null
  toolCallId: string | null
  action: string | null
  resourceHash: string | null
  materialHash: string | null
  answersHash: string | null
  scopeHash: string | null
  revision: number | null
  expiresAt: string | null
}

export interface ApprovalPresentation {
  state: ApprovalViewState
  canAct: boolean
  reason: string
  scope: ApprovalScopeView
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function optionalRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function readApprovalScope(value: unknown): ApprovalScopeView {
  const raw = record(value)
  return {
    sessionId: optionalString(raw.sessionId), turnId: optionalString(raw.turnId), jobId: optionalString(raw.jobId),
    toolCallId: optionalString(raw.toolCallId), action: optionalString(raw.action), resourceHash: optionalString(raw.resourceHash),
    materialHash: optionalString(raw.materialHash), answersHash: optionalString(raw.answersHash), scopeHash: optionalString(raw.scopeHash),
    revision: optionalRevision(raw.revision), expiresAt: optionalString(raw.expiresAt),
  }
}

export function approvalPresentation(input: {
  approvalId?: string | null
  status?: string | null
  acted?: boolean
  scope?: unknown
  eventTurnId?: string | null
  currentTurnId?: string | null
  now?: Date | number
}): ApprovalPresentation {
  const scope = readApprovalScope(input.scope)
  if (input.acted || (input.status && input.status !== 'pending')) return { state: 'answered', canAct: false, reason: 'Decision already recorded; this approval is read-only.', scope }
  if (!input.approvalId || !scope.sessionId || !scope.turnId || !scope.toolCallId || !scope.action || !scope.scopeHash) {
    return { state: 'unavailable', canAct: false, reason: 'Approval scope is unavailable; refresh before deciding.', scope }
  }
  const expectedTurn = input.currentTurnId ?? input.eventTurnId
  if (expectedTurn && expectedTurn !== scope.turnId) return { state: 'stale', canAct: false, reason: 'This approval belongs to another Turn and cannot be applied here.', scope }
  const now = input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now()
  if (scope.expiresAt && Number.isFinite(Date.parse(scope.expiresAt)) && Date.parse(scope.expiresAt) <= now) return { state: 'expired', canAct: false, reason: 'This approval has expired; refresh for a new scope.', scope }
  return { state: 'pending', canAct: true, reason: 'Awaiting your decision for this scoped action.', scope }
}

export type ArtifactViewState = 'current' | 'stale' | 'uncertain'

export function artifactViewState(input: { stale?: boolean; hash?: string | null; version?: number | string | null; turnId?: string | null; currentTurnId?: string | null }): ArtifactViewState {
  if (input.stale || (input.turnId && input.currentTurnId && input.turnId !== input.currentTurnId)) return 'stale'
  if (!input.hash || input.version == null) return 'uncertain'
  return 'current'
}

export function budgetViewState(used: number | null | undefined, limit: number | null | undefined): 'ok' | 'near_limit' | 'exhausted' | 'unknown' {
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) return 'unknown'
  if (used >= limit) return 'exhausted'
  return used / limit >= 0.8 ? 'near_limit' : 'ok'
}

export function isHeartbeatEvent(type: string): boolean {
  return type === 'heartbeat' || type === 'system_heartbeat' || type === 'agent_heartbeat'
}

export function isNoiseEvent(type: string): boolean {
  return isHeartbeatEvent(type)
}
