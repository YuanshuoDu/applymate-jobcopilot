import type { Pool } from "pg"
import type { ApplicationSubmissionExecution } from "../queue/application-submit-fence.js"
import { finishApplicationTaskWithClient } from "./application-task-state.js"
import { withExactSubmissionWrite } from "./submission-guard.js"

type Result = "written" | "superseded" | "unverified"
type Row = Record<string, unknown>
const FIELDS = ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash", "workerTaskId", "executionId"] as const

/** Decreases authority only when the exact started execution still owns the task. */
export async function markExactStartedObjectiveSubmissionUncertain(
  pool: Pool, scope: ApplicationSubmissionExecution, message: string,
): Promise<Result> {
  if (!FIELDS.every(key => typeof scope[key] === "string" && scope[key].trim().length > 0)
    || !/^[a-f0-9]{64}$/.test(scope.constraintHash)) return "unverified"
  const outcome = await withExactSubmissionWrite(pool, scope, "objective_started_uncertain", async client => {
    const tasks = await client.query<Row>(`SELECT "workerTaskId", "status", "checkpoint" FROM "application_tasks"
      WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 LIMIT 2`,
    [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId])
    if (tasks.rows.length !== 1) return "unverified" as const
    const task = tasks.rows[0]!
    if (task.workerTaskId !== scope.workerTaskId) return "superseded" as const
    const events = await client.query<Row>(`SELECT "id", "taskId", "type", "actor", "body", "data" FROM "application_task_events"
      WHERE "taskId"=$1 AND "type"='submission_execution_started'
        AND ("id"=$2 OR "data"->>'workerTaskId'=$3 OR "data"->>'approvalId'=$4) LIMIT 2`,
    [scope.applicationTaskId, `evt_${scope.executionId}`, scope.workerTaskId, scope.approvalId])
    if (events.rows.length !== 1 || !matchesStart(events.rows[0], scope)) return "unverified" as const
    if (task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain") return "written" as const
    if (!(task.status === "filling" && task.checkpoint === "submission_request_started")
      && !(task.status === "cancelled" && task.checkpoint === "turn_stopped_before_submit")) return "unverified" as const
    const written = await finishApplicationTaskWithClient(client, scope.applicationTaskId, "waiting_for_user", "submission_uncertain", message, scope)
    return written === "current" ? "written" as const : "superseded" as const
  })
  return outcome.kind === "current" ? outcome.value : "superseded"
}

function matchesStart(row: Row | undefined, scope: ApplicationSubmissionExecution): boolean {
  if (!row || row.id !== `evt_${scope.executionId}` || row.taskId !== scope.applicationTaskId
    || row.type !== "submission_execution_started" || row.actor !== "worker" || row.body !== "Submit execution started") return false
  const value = row.data
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const data = value as Row
  return Object.keys(data).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(data, key) && data[key] === scope[key])
}
