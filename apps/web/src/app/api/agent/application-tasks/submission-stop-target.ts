import {
  applicationSubmissionStopEventId,
  matchesExactApplicationSubmissionStopAttempt,
  parseApplicationSubmissionStopRecord,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopEventKey,
  type ApplicationSubmissionStopStage,
} from "@jobcopilot/shared/application-submission-stop-protocol"

import { db } from "@/lib/db"

const STOP_EVENT_TYPE = "submission_stop_protocol"
const STOP_EVENT_BODY = "Application submission Stop protocol state recorded."
const START_EVENT_BODY = "Submit execution started"
const EVENT_TYPES = ["submission_queued", "submission_execution_started", "submission_execution_settled", "submission_evidence_recorded", STOP_EVENT_TYPE]
const QUEUE_KEYS = ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "receiptId", "constraintHash", "workerTaskId"]
const START_KEYS = ["executionId", "workerTaskId", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash"]
const MAX_TASKS = 20
const MAX_EVENTS = 33

export type SubmissionStopTargetTask = Readonly<{
  id: string; userId: string; sessionId: string | null; jobId: string; fillTurnId: string | null
  fillTurnSessionId: string | null; fillTurnUserId: string | null; workerTaskId: string | null
  status: string; checkpoint: string | null
}>
type EventRow = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown }
type CurrentTask = SubmissionStopTargetTask & { events: EventRow[] }
type AttemptBase = Omit<ApplicationSubmissionStopAttempt, "executionId">

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
function eligible(task: SubmissionStopTargetTask, userId: string, sessionId: string): boolean {
  return task.userId === userId && task.sessionId === sessionId && task.status === "filling"
    && task.checkpoint === "submission_request_started" && task.fillTurnSessionId === sessionId
    && task.fillTurnUserId === userId && [task.id, task.jobId, task.fillTurnId, task.workerTaskId].every(nonEmpty)
}
function sameAttemptSnapshot(a: SubmissionStopTargetTask, b: SubmissionStopTargetTask): boolean {
  return a.id === b.id && a.userId === b.userId && a.sessionId === b.sessionId && a.jobId === b.jobId
    && a.fillTurnId === b.fillTurnId && a.fillTurnSessionId === b.fillTurnSessionId
    && a.fillTurnUserId === b.fillTurnUserId && a.workerTaskId === b.workerTaskId
    && a.status === b.status && a.checkpoint === b.checkpoint
}
function queueBase(event: EventRow): AttemptBase | null {
  if (event.type !== "submission_queued" || event.actor !== "user" || !plainRecord(event.data) || !exactKeys(event.data, QUEUE_KEYS)) return null
  const row = event.data
  if (!nonEmpty(row.applicationTaskId) || !nonEmpty(row.userId) || !nonEmpty(row.jobId) || !nonEmpty(row.sessionId)
    || !nonEmpty(row.fillTurnId) || !nonEmpty(row.approvalId) || !nonEmpty(row.receiptId) || !nonEmpty(row.workerTaskId)
    || row.approvalId !== row.receiptId || !validHash(row.constraintHash)) return null
  return {
    applicationTaskId: row.applicationTaskId, userId: row.userId, jobId: row.jobId, sessionId: row.sessionId,
    fillTurnId: row.fillTurnId, approvalId: row.approvalId, receiptId: row.receiptId,
    constraintHash: row.constraintHash, workerTaskId: row.workerTaskId,
  }
}
function startAttempt(event: EventRow): ApplicationSubmissionStopAttempt | null {
  if (event.type !== "submission_execution_started" || event.actor !== "worker" || !plainRecord(event.data) || !exactKeys(event.data, START_KEYS)) return null
  const row = event.data
  if (!nonEmpty(row.executionId) || !nonEmpty(row.workerTaskId) || !nonEmpty(row.applicationTaskId) || !nonEmpty(row.userId)
    || !nonEmpty(row.jobId) || !nonEmpty(row.sessionId) || !nonEmpty(row.fillTurnId) || !nonEmpty(row.approvalId)
    || !validHash(row.constraintHash)) return null
  return {
    executionId: row.executionId, workerTaskId: row.workerTaskId, applicationTaskId: row.applicationTaskId,
    userId: row.userId, jobId: row.jobId, sessionId: row.sessionId, fillTurnId: row.fillTurnId,
    approvalId: row.approvalId, receiptId: row.approvalId, constraintHash: row.constraintHash,
  }
}
function eventKey(attempt: ApplicationSubmissionStopAttempt): ApplicationSubmissionStopEventKey {
  const { executionId: _executionId, ...key } = attempt
  return key
}
function stageForEvent(event: EventRow): ApplicationSubmissionStopStage | null {
  const record = parseApplicationSubmissionStopRecord(event.data)
  if (!record || event.taskId !== record.applicationTaskId || event.type !== STOP_EVENT_TYPE
    || event.actor !== (record.stage === "stop_requested" ? "user" : "worker") || event.body !== STOP_EVENT_BODY
    || event.id !== applicationSubmissionStopEventId(eventKey(record), record.stage)) return null
  return record.stage
}
async function targetForTask(task: CurrentTask): Promise<string | null> {
  if (task.events.length > MAX_EVENTS) return null
  const queued: AttemptBase[] = [], started: ApplicationSubmissionStopAttempt[] = []
  const protocol: Array<{ stage: ApplicationSubmissionStopStage; data: unknown }> = []
  for (const event of task.events) {
    if (event.taskId !== task.id) return null
    if (event.type === "submission_queued") {
      const parsed = queueBase(event)
      if (!parsed) return null
      queued.push(parsed)
    } else if (event.type === "submission_execution_started") {
      const parsed = startAttempt(event)
      if (!parsed || event.body !== START_EVENT_BODY || event.id !== `evt_${parsed.executionId}`) return null
      started.push(parsed)
    } else if (event.type === STOP_EVENT_TYPE) {
      const stage = stageForEvent(event)
      if (!stage) return null
      const parsed = parseApplicationSubmissionStopRecord(event.data)
      if (parsed) protocol.push({ stage, data: event.data })
    } else if (event.type === "submission_execution_settled" || event.type === "submission_evidence_recorded") {
      if (!plainRecord(event.data) || !nonEmpty(event.data.workerTaskId)) return null
      if (event.data.workerTaskId === task.workerTaskId) return null
    }
  }
  const currentQueues = queued.filter(row => row.workerTaskId === task.workerTaskId)
  const currentStarts = started.filter(row => row.workerTaskId === task.workerTaskId)
  if (currentQueues.length !== 1 || currentStarts.length !== 1) return null
  const attempt = currentStarts[0]!, queue = currentQueues[0]!
  if (queued.some(row => row.approvalId === queue.approvalId && row.workerTaskId !== queue.workerTaskId)
    || started.some(row => row.approvalId === attempt.approvalId && row.workerTaskId !== attempt.workerTaskId)) return null
  if (attempt.applicationTaskId !== task.id || attempt.userId !== task.userId || attempt.sessionId !== task.sessionId
    || attempt.jobId !== task.jobId || attempt.fillTurnId !== task.fillTurnId || attempt.workerTaskId !== task.workerTaskId
    || queue.applicationTaskId !== attempt.applicationTaskId || queue.userId !== attempt.userId || queue.sessionId !== attempt.sessionId
    || queue.jobId !== attempt.jobId || queue.fillTurnId !== attempt.fillTurnId || queue.workerTaskId !== attempt.workerTaskId
    || queue.approvalId !== attempt.approvalId || queue.receiptId !== attempt.receiptId || queue.constraintHash !== attempt.constraintHash) return null
  const stages = new Map<ApplicationSubmissionStopStage, number>()
  for (const row of protocol) {
    const parsed = parseApplicationSubmissionStopRecord(row.data)
    if (parsed?.approvalId === attempt.approvalId && parsed.workerTaskId !== attempt.workerTaskId) return null
    if (parsed?.workerTaskId !== attempt.workerTaskId) continue
    if (!matchesExactApplicationSubmissionStopAttempt(row.data, attempt)) return null
    stages.set(row.stage, (stages.get(row.stage) ?? 0) + 1)
  }
  if (stages.get("armed") !== 1 || stages.has("stop_requested") || stages.has("dispatch_granted")) return null
  try {
    const { createApplicationSubmissionStopTarget } = await import("./submission-stop")
    return createApplicationSubmissionStopTarget(attempt)
  } catch {
    return null
  }
}

/** Returns opaque targets only for bounded, currently owned attempts with exact server evidence. */
export async function readApplicationSubmissionStopTargets(
  userId: string, sessionId: string, snapshots: readonly SubmissionStopTargetTask[],
): Promise<ReadonlyMap<string, string>> {
  const candidates = snapshots.filter(task => eligible(task, userId, sessionId))
  if (!candidates.length || candidates.length > MAX_TASKS || new Set(candidates.map(task => task.id)).size !== candidates.length) return new Map()
  const tasks = await db.applicationTask.findMany({
    where: { id: { in: candidates.map(task => task.id) }, userId, sessionId, status: "filling", checkpoint: "submission_request_started" },
    orderBy: { id: "asc" }, take: candidates.length,
    select: {
      id: true, userId: true, sessionId: true, jobId: true, fillTurnId: true, fillTurnSessionId: true,
      fillTurnUserId: true, workerTaskId: true, status: true, checkpoint: true,
      events: { where: { type: { in: EVENT_TYPES } }, orderBy: { id: "asc" }, take: MAX_EVENTS + 1,
        select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } },
    },
  }) as CurrentTask[]
  const counts = new Map<string, number>(), targets = new Map<string, string>()
  for (const task of tasks) {
    counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
    if (counts.get(task.id) !== 1) {
      targets.delete(task.id)
      continue
    }
    const prior = candidates.find(candidate => candidate.id === task.id)
    if (!prior || !eligible(task, userId, sessionId) || !sameAttemptSnapshot(prior, task)) continue
    const target = await targetForTask(task)
    if (target) targets.set(task.id, target)
  }
  return targets
}
