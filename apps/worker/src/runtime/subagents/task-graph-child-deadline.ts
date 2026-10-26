export const TASK_GRAPH_CHILD_ABSOLUTE_LIFETIME_MS = 60 * 60 * 1000
export const TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON = "task_graph_child_deadline_exceeded"
export const TASK_GRAPH_CHILD_RUNNING_SEGMENT_MS = 5 * 60 * 1000

/** Compare against a timestamp read from the database, never an implicit process clock. */
export function isTaskGraphChildDeadlineReached(deadlineAt: Date | null | undefined, databaseNow: Date): boolean {
  return deadlineAt != null && databaseNow.getTime() >= deadlineAt.getTime()
}
