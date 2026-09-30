import { CoordinationError, type CoordinationTaskView } from "./coordination-types.js"

export const TERMINAL_TASK_STATUSES = new Set([
  "completed", "failed", "interrupted", "cancelled", "closed",
])

export type FollowupProvenance = {
  readonly sourceTaskId: string
  readonly sourceStatus: string
  readonly sourceAttemptCount: number
  readonly priorResult: unknown
}

export type FollowupRedactor = (value: unknown) => unknown

export function followupOutput(task: CoordinationTaskView, sourceTaskId: string, replay: boolean) {
  return {
    taskId: task.id, sourceTaskId, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId,
    path: task.path, depth: task.depth, status: task.status, replay,
  }
}

export function followupContext(value: unknown, source: CoordinationTaskView, redact: FollowupRedactor): unknown {
  const provenance = {
    kind: "agent.followup" as const,
    sourceTaskId: source.id,
    sourceStatus: source.status,
    sourceAttemptCount: source.attemptCount,
    priorResult: redact(source.result),
  }
  const caller = value === undefined ? undefined : redact(value)
  return { callerContext: caller ?? null, provenance }
}

export function followupProvenance(value: unknown): FollowupProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const provenance = (value as Record<string, unknown>).provenance
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null
  const row = provenance as Record<string, unknown>
  if (row.kind !== "agent.followup" || typeof row.sourceTaskId !== "string"
    || !TERMINAL_TASK_STATUSES.has(String(row.sourceStatus))
    || typeof row.sourceAttemptCount !== "number" || !Number.isSafeInteger(row.sourceAttemptCount)
    || row.sourceAttemptCount < 0) return null
  return {
    sourceTaskId: row.sourceTaskId,
    sourceStatus: String(row.sourceStatus),
    sourceAttemptCount: Number(row.sourceAttemptCount),
    priorResult: row.priorResult,
  }
}

export function assertFollowupReplay(
  replay: CoordinationTaskView,
  source: CoordinationTaskView,
  parent: CoordinationTaskView,
  provenance: FollowupProvenance | null,
  turnId: string,
): void {
  if (!provenance || provenance.sourceTaskId !== source.id
    || provenance.sourceStatus !== source.status
    || provenance.sourceAttemptCount !== source.attemptCount) {
    throw new CoordinationError("coordination_idempotency_conflict", "Follow-up provenance does not match its source task")
  }
  if (replay.turnId !== turnId || replay.parentTaskId !== parent.id || replay.rootTaskId !== parent.rootTaskId
    || replay.role !== source.role || replay.taskType !== source.taskType
    || replay.depth !== parent.depth + 1 || !isTaskPathWithin(replay.path, parent.path)) {
    throw new CoordinationError("coordination_idempotency_conflict", "Follow-up replay does not match the current runtime parent")
  }
}

function isTaskPathWithin(path: string, ancestorPath: string): boolean {
  return path.startsWith(`${ancestorPath}/`)
}
