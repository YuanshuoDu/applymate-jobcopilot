import {
  unknownApplicationSubmissionEvidence,
  type ApplicationSubmissionEvidence,
} from "./application-submission-evidence"

export type ApplicationTaskRow = { status: string }

export type ApplicationTaskProjectionSource = Readonly<{
  id: string
  userId: string
  jobId: string
  sessionId: string | null
  status: string
  checkpoint: string | null
  updatedAt: Date
  job: Readonly<{ company: string; role: string }>
}>

export type ApplicationTaskReadView = Readonly<{
  id: string
  userId: string
  jobId: string
  sessionId: string | null
  status: string
  checkpoint: string | null
  updatedAt: string
  job: Readonly<{ company: string; role: string }>
  submissionEvidence: ApplicationSubmissionEvidence
}>

const SUBMISSION_CHECKPOINTS = new Set([
  "submission_request_started", "submission_authorized", "submission_uncertain", "submission_verified", "submission_blocked",
  "execution_interrupted", "receipt_rejected", "queue_retry",
])

function submissionRelevant(status: string, checkpoint: string | null): boolean {
  return status === "submitted" || status === "unknown" || SUBMISSION_CHECKPOINTS.has(checkpoint ?? "")
}

function boundedEvidence(
  evidence: ApplicationSubmissionEvidence | undefined,
  task: ApplicationTaskProjectionSource,
): ApplicationSubmissionEvidence {
  const relevant = submissionRelevant(task.status, task.checkpoint)
  const visible = relevant || evidence?.visible === true
  const availability = evidence?.availability === "available" || evidence?.availability === "unavailable"
    || evidence?.availability === "unknown" ? evidence.availability : "unknown"
  if (!evidence || evidence.visible !== true || !visible) {
    return unknownApplicationSubmissionEvidence(visible, availability === "unavailable" ? "unavailable" : "unknown")
  }
  const workerReport = availability === "available" && evidence.workerReport === "submitted" ? "submitted" : "unknown"
  return {
    visible: true,
    availability,
    workerReport,
    localRecord: workerReport === "submitted" && evidence.localRecord === "recorded" ? "recorded" : "unknown",
    employerReceipt: "unverified",
  }
}

/** Project only the owner-scoped fields consumed by the Task card. */
export function projectApplicationTaskReadViews(
  tasks: readonly ApplicationTaskProjectionSource[],
  evidenceByTaskId: ReadonlyMap<string, ApplicationSubmissionEvidence>,
): ApplicationTaskReadView[] {
  return tasks.map(task => ({
    id: task.id,
    userId: task.userId,
    jobId: task.jobId,
    sessionId: task.sessionId,
    status: task.status,
    checkpoint: task.checkpoint,
    updatedAt: task.updatedAt.toISOString(),
    job: { company: task.job.company, role: task.job.role },
    submissionEvidence: boundedEvidence(evidenceByTaskId.get(task.id), task),
  }))
}

export function applicationTaskSummary(tasks: ApplicationTaskRow[]) {
  return tasks.reduce((summary, task) => {
    if (task.status === "submitted") summary.submitted++
    else if (task.status === "skipped") summary.skipped++
    else if (task.status === "failed") summary.failed++
    else if (task.status === "waiting_for_user" || task.status === "waiting_for_authorization") summary.needsUser++
    else summary.inProgress++
    return summary
  }, { submitted: 0, skipped: 0, failed: 0, needsUser: 0, inProgress: 0 })
}

export function mayCancelApplicationTask(status: string): boolean {
  return !["submitted", "skipped", "cancelled"].includes(status)
}
