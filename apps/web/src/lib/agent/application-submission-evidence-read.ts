import type { PrismaClient } from "@prisma/client"
import {
  evaluateApplicationSubmissionEvidence,
  unknownApplicationSubmissionEvidence,
  type ApplicationSubmissionEvidence,
  type SubmissionEvidenceApproval,
  type SubmissionEvidenceEvent,
  type SubmissionEvidenceEventType,
  type SubmissionEvidenceTask,
} from "./application-submission-evidence"

const MAX_APPLICATION_TASKS = 100
const MAX_EVENTS_PER_TASK = 33
const SUBMISSION_EVENTS = ["submission_queued", "submission_execution_started", "submission_execution_settled", "submission_evidence_recorded"]
const SUBMISSION_CHECKPOINTS = new Set([
  "submission_request_started", "submission_authorized", "submission_uncertain", "submission_verified", "submission_blocked",
  "execution_interrupted", "receipt_rejected", "queue_retry",
])

type EvidenceReadClient = Pick<PrismaClient, "applicationTask" | "agentApproval">
type EvidenceReadTask = SubmissionEvidenceTask & Readonly<{ updatedAt: Date }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSubmissionRelevant(task: Pick<EvidenceReadTask, "status" | "checkpoint">): boolean {
  return task.status === "submitted" || task.status === "unknown" || SUBMISSION_CHECKPOINTS.has(task.checkpoint ?? "")
}

function visibleTaskIds(tasks: readonly EvidenceReadTask[], eventsByTaskId: ReadonlyMap<string, readonly SubmissionEvidenceEvent[]>, userId: string): Set<string> {
  return new Set(tasks.filter(task => task.userId === userId && (isSubmissionRelevant(task) || (eventsByTaskId.get(task.id)?.length ?? 0) > 0)).map(task => task.id))
}

function unavailableEvidence(
  tasks: readonly EvidenceReadTask[], userId: string, additionalVisible = new Set<string>(),
): ReadonlyMap<string, ApplicationSubmissionEvidence> {
  return new Map(tasks.map(task => {
    const visible = Boolean(userId) && task.userId === userId && (isSubmissionRelevant(task) || additionalVisible.has(task.id))
    return [task.id, unknownApplicationSubmissionEvidence(visible, visible ? "unavailable" : "unknown")]
  }))
}

function sameTaskSnapshot(base: EvidenceReadTask, current: SubmissionEvidenceTask & { updatedAt: Date }): boolean {
  return base.id === current.id && base.userId === current.userId && base.jobId === current.jobId && base.sessionId === current.sessionId &&
    base.fillTurnId === current.fillTurnId && base.fillTurnSessionId === current.fillTurnSessionId &&
    base.fillTurnUserId === current.fillTurnUserId && base.workerTaskId === current.workerTaskId &&
    base.status === current.status && base.checkpoint === current.checkpoint && base.updatedAt.getTime() === current.updatedAt.getTime()
}

function approvalIdForEvidence(events: readonly SubmissionEvidenceEvent[]): string | null {
  const records = events.filter(event => event.type === "submission_evidence_recorded")
  if (records.length !== 1 || !isRecord(records[0].data)) return null
  const id = records[0].data.approvalId
  return typeof id === "string" && id.trim() ? id : null
}

/** Read only owner-scoped Task events and approval metadata; never query SubmissionAttempt. */
export async function readApplicationSubmissionEvidence(
  client: EvidenceReadClient,
  userId: string,
  tasks: readonly EvidenceReadTask[],
): Promise<ReadonlyMap<string, ApplicationSubmissionEvidence>> {
  if (!userId || tasks.length > MAX_APPLICATION_TASKS) return unavailableEvidence(tasks, userId)
  if (tasks.length === 0) return new Map()
  const taskIds = [...new Set(tasks.filter(task => task.userId === userId).map(task => task.id))]
  if (taskIds.length === 0) return unavailableEvidence(tasks, userId)

  let rows
  try {
    rows = await client.applicationTask.findMany({
      where: { userId, id: { in: taskIds } },
      select: {
        id: true, userId: true, jobId: true, sessionId: true, fillTurnId: true, fillTurnSessionId: true,
        fillTurnUserId: true, workerTaskId: true, status: true, checkpoint: true, updatedAt: true,
        events: {
          where: { type: { in: SUBMISSION_EVENTS } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_EVENTS_PER_TASK,
          select: { id: true, type: true, actor: true, data: true },
        },
      },
    })
  } catch {
    return unavailableEvidence(tasks, userId)
  }

  const currentById = new Map(rows.map(row => [row.id, row]))
  const eventsByTaskId = new Map<string, readonly SubmissionEvidenceEvent[]>(rows.map(row => [row.id, row.events.map(event => ({
    id: event.id, type: event.type as SubmissionEvidenceEventType, actor: event.actor, data: event.data,
  }))]))
  const visible = visibleTaskIds(tasks, eventsByTaskId, userId)
  const approvalIds = [...new Set([...eventsByTaskId.values()].flatMap(approvalIdForEvidence).filter((id): id is string => id !== null))]

  let approvalRows: readonly SubmissionEvidenceApproval[] = []
  if (approvalIds.length > 0) {
    try {
      approvalRows = await client.agentApproval.findMany({
        where: { userId, id: { in: approvalIds }, taskId: { in: taskIds } }, take: MAX_APPLICATION_TASKS,
        select: { id: true, userId: true, sessionId: true, taskId: true, turnId: true, jobId: true,
          toolCallId: true, type: true, status: true, scopeHash: true, resourceHash: true },
      })
    } catch {
      return unavailableEvidence(tasks, userId, visible)
    }
  }
  const approvalsByTask = new Map<string, SubmissionEvidenceApproval[]>()
  for (const approval of approvalRows) {
    if (!approval.taskId) continue
    approvalsByTask.set(approval.taskId, [...(approvalsByTask.get(approval.taskId) ?? []), approval])
  }

  return new Map(tasks.map(task => {
    if (task.userId !== userId) return [task.id, unknownApplicationSubmissionEvidence(false, "unknown")]
    const current = currentById.get(task.id)
    const events = eventsByTaskId.get(task.id) ?? []
    const isVisible = visible.has(task.id)
    if (!current || !sameTaskSnapshot(task, current)) return [task.id, unknownApplicationSubmissionEvidence(isVisible, "unknown")]
    return [task.id, evaluateApplicationSubmissionEvidence({
      task: current, events, approvals: approvalsByTask.get(task.id) ?? [],
    })]
  }))
}
