export type TaskGraphNode = {
  readonly id: string
  readonly dependsOn: readonly string[]
}

export type TaskGraphStatus = "pending" | "ready" | "running" | "completed" | "failed" | "waiting" | "cancelled"
export type TaskGraphEventType = "start" | "complete" | "fail" | "wait" | "cancel" | "retry"
export type TaskGraphEvent = { readonly type: TaskGraphEventType; readonly nodeId: string; readonly eventId: string; readonly attempt?: number }
export type TaskGraphBlockReason = "waiting_on_dependencies" | "dependency_failed"

export type TaskGraphState = {
  readonly nodes: readonly TaskGraphNode[]
  readonly statuses: Readonly<Record<string, TaskGraphStatus>>
  readonly readyNodeIds: readonly string[]
  readonly blockedReasons: Readonly<Record<string, TaskGraphBlockReason>>
  readonly appliedEvents: readonly TaskGraphEvent[]
}

export type TaskGraphErrorCode =
  | "invalid_graph"
  | "duplicate_node"
  | "missing_dependency"
  | "cycle"
  | "invalid_event"
  | "unknown_node"
  | "duplicate_event"
  | "illegal_transition"

export class TaskGraphError extends Error {
  constructor(readonly code: TaskGraphErrorCode, message: string) {
    super(message)
    this.name = "TaskGraphError"
  }
}

export type TaskGraphReduction =
  | { readonly ok: true; readonly state: TaskGraphState }
  | { readonly ok: false; readonly state: TaskGraphState; readonly errorCode: TaskGraphErrorCode; readonly message: string }

const statuses = (nodes: readonly TaskGraphNode[]): Record<string, TaskGraphStatus> =>
  Object.fromEntries(nodes.map((node) => [node.id, node.dependsOn.length === 0 ? "ready" : "pending"])) as Record<string, TaskGraphStatus>

const validateNodes = (nodes: readonly TaskGraphNode[]): void => {
  if (!Array.isArray(nodes)) throw new TaskGraphError("invalid_graph", "Nodes must be an array")
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id || !Array.isArray(node.dependsOn)) throw new TaskGraphError("invalid_graph", "Malformed graph node")
    if (ids.has(node.id)) throw new TaskGraphError("duplicate_node", `Duplicate node ${node.id}`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    const dependencies = new Set<string>()
    for (const dependency of node.dependsOn) {
      if (typeof dependency !== "string" || !dependency) throw new TaskGraphError("invalid_graph", `Malformed dependency for ${node.id}`)
      if (dependencies.has(dependency)) throw new TaskGraphError("invalid_graph", `Duplicate dependency ${dependency}`)
      if (!ids.has(dependency)) throw new TaskGraphError("missing_dependency", `${node.id} depends on missing ${dependency}`)
      dependencies.add(dependency)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TaskGraphError("cycle", `Dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const node = nodes.find((candidate) => candidate.id === id)
    for (const dependency of node?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of nodes) visit(node.id)
}

const dependencyFailed = (state: TaskGraphState, nodeId: string, memo: Map<string, boolean>): boolean => {
  const cached = memo.get(nodeId)
  if (cached !== undefined) return cached
  const node = state.nodes.find((candidate) => candidate.id === nodeId)
  const failed = node?.dependsOn.some((dependency) => {
    const status = state.statuses[dependency]
    return status === "failed" || status === "cancelled" || (status === "pending" && dependencyFailed(state, dependency, memo))
  }) ?? false
  memo.set(nodeId, failed)
  return failed
}

const derive = (state: Omit<TaskGraphState, "readyNodeIds" | "blockedReasons">): TaskGraphState => {
  const readyNodeIds = state.nodes.filter((node) => state.statuses[node.id] === "ready").map((node) => node.id)
  const memo = new Map<string, boolean>()
  const blockedReasons: Record<string, TaskGraphBlockReason> = {}
  for (const node of state.nodes) {
    if (state.statuses[node.id] !== "pending") continue
    blockedReasons[node.id] = dependencyFailed(state as TaskGraphState, node.id, memo)
      ? "dependency_failed"
      : "waiting_on_dependencies"
  }
  return { ...state, readyNodeIds, blockedReasons }
}

const eventAttempt = (event: TaskGraphEvent): number => event.attempt ?? 1

const currentAttempt = (state: TaskGraphState, nodeId: string): number => {
  for (let index = state.appliedEvents.length - 1; index >= 0; index -= 1) {
    const event = state.appliedEvents[index]
    if (event?.nodeId === nodeId) return eventAttempt(event)
  }
  return 1
}

export function createTaskGraph(input: readonly TaskGraphNode[]): TaskGraphState {
  validateNodes(input)
  const nodes = input.map((node) => ({ id: node.id, dependsOn: [...node.dependsOn] }))
  return derive({ nodes, statuses: statuses(nodes), appliedEvents: [] })
}

const validEvent = (event: TaskGraphEvent): boolean => {
  if (!event || typeof event !== "object") return false
  if (!["start", "complete", "fail", "wait", "cancel", "retry"].includes(event.type)) return false
  if (typeof event.nodeId !== "string" || event.nodeId.length === 0 || typeof event.eventId !== "string" || event.eventId.length === 0) return false
  if (event.attempt !== undefined && (!Number.isSafeInteger(event.attempt) || event.attempt < 1 || event.attempt > 2)) return false
  if (event.type === "retry" && event.attempt !== 2) return false
  return true
}

const nextStatus = (status: TaskGraphStatus, type: TaskGraphEventType): TaskGraphStatus | undefined => {
  if (type === "start" && (status === "ready" || status === "waiting")) return "running"
  if (type === "complete" && status === "running") return "completed"
  if (type === "fail" && status === "running") return "failed"
  if (type === "wait" && status === "running") return "waiting"
  if (type === "cancel" && ["pending", "ready", "running", "waiting"].includes(status)) return "cancelled"
  if (type === "retry" && status === "running") return "ready"
  return undefined
}

const failure = (state: TaskGraphState, errorCode: TaskGraphErrorCode, message: string): TaskGraphReduction => ({ ok: false, state, errorCode, message })

export function reduceTaskGraph(state: TaskGraphState, event: TaskGraphEvent): TaskGraphReduction {
  if (!validEvent(event)) return failure(state, "invalid_event", "Malformed task graph event")
  const previous = state.appliedEvents.find((candidate) => candidate.eventId === event.eventId)
  if (previous) {
    if (previous.nodeId === event.nodeId && previous.type === event.type && eventAttempt(previous) === eventAttempt(event)) {
      if (eventAttempt(event) < currentAttempt(state, event.nodeId)) return failure(state, "duplicate_event", `Event id ${event.eventId} belongs to an earlier attempt`)
      return { ok: true, state }
    }
    return failure(state, "duplicate_event", `Event id ${event.eventId} was already applied`)
  }
  if (!(event.nodeId in state.statuses)) return failure(state, "unknown_node", `Unknown node ${event.nodeId}`)
  const current = state.statuses[event.nodeId]
  const attempt = eventAttempt(event)
  const activeAttempt = currentAttempt(state, event.nodeId)
  if (event.type === "retry" && (attempt !== 2 || activeAttempt !== 1)) return failure(state, "illegal_transition", `Cannot retry node ${event.nodeId} from attempt ${activeAttempt}`)
  if (event.type !== "retry" && attempt !== activeAttempt) return failure(state, "illegal_transition", `Event attempt ${attempt} does not match node ${event.nodeId} attempt ${activeAttempt}`)
  const next = nextStatus(current, event.type)
  if (!next) return failure(state, "illegal_transition", `Cannot ${event.type} node ${event.nodeId} from ${current}`)
  const updated = {
    nodes: state.nodes,
    statuses: { ...state.statuses, [event.nodeId]: next },
    appliedEvents: [...state.appliedEvents, { ...event }],
  }
  for (const node of updated.nodes) {
    if (updated.statuses[node.id] === "pending" && node.dependsOn.every((dependency) => updated.statuses[dependency] === "completed")) {
      updated.statuses[node.id] = "ready"
    }
  }
  return { ok: true, state: derive(updated) }
}
