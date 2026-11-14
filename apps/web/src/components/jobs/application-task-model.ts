import {
  unknownApplicationSubmissionEvidence,
  type ApplicationSubmissionEvidence,
} from "@/lib/agent/application-submission-evidence"

export interface ApplicationTaskView {
  id: string
  jobId: string
  sessionId: string | null
  status: string
  checkpoint: string | null
  company: string
  role: string
  updatedAt: string
  submissionEvidence?: ApplicationSubmissionEvidence
}

export type ApplicationTaskKind = 'preparing' | 'filling' | 'needsInput' | 'needsMaterialsReview' | 'needsHandoff' | 'needsUserAction' | 'fillUncertain' | 'needsApproval' | 'submitting' | 'submitted' | 'unknown' | 'failed' | 'cancelled' | 'skipped' | 'unavailable'

export interface ApplicationTaskState {
  kind: ApplicationTaskKind
  needsAttention: boolean
  labelKey: string
  descriptionKey: string
  actionKey: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\s/.test(value)
}

function displayText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500
}

const SUBMISSION_CHECKPOINTS = new Set([
  'submission_request_started', 'submission_authorized', 'submission_uncertain', 'submission_verified', 'submission_blocked',
  'execution_interrupted', 'receipt_rejected', 'queue_retry',
])

function submissionRelevant(status: string, checkpoint: string | null): boolean {
  return status === 'submitted' || status === 'unknown' || SUBMISSION_CHECKPOINTS.has(checkpoint ?? '')
}

function submissionEvidence(value: unknown, status: string, checkpoint: string | null): ApplicationSubmissionEvidence {
  const input = record(value)
  const relevant = submissionRelevant(status, checkpoint) || input?.visible === true
  const availability = input?.availability === 'available' || input?.availability === 'unavailable' || input?.availability === 'unknown'
    ? input.availability : 'unknown'
  const keys = ['visible', 'availability', 'workerReport', 'localRecord', 'employerReceipt']
  const valid = input !== null && Object.keys(input).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(input, key))
    && typeof input.visible === 'boolean'
    && (input.workerReport === 'submitted' || input.workerReport === 'unknown')
    && (input.localRecord === 'recorded' || input.localRecord === 'unknown')
    && input.employerReceipt === 'unverified'
    && (availability === 'available' || (input.workerReport === 'unknown' && input.localRecord === 'unknown'))
    && (input.localRecord !== 'recorded' || input.workerReport === 'submitted')
    && (input.availability === 'available' || input.availability === 'unavailable' || input.availability === 'unknown')
  if (!valid) return unknownApplicationSubmissionEvidence(relevant, availability === 'unavailable' ? 'unavailable' : 'unknown')
  if (!input.visible) return unknownApplicationSubmissionEvidence(relevant, availability === 'unavailable' ? 'unavailable' : 'unknown')
  return {
    visible: true,
    availability,
    workerReport: availability === 'available' && input.workerReport === 'submitted' ? 'submitted' : 'unknown',
    localRecord: availability === 'available' && input.workerReport === 'submitted' && input.localRecord === 'recorded' ? 'recorded' : 'unknown',
    employerReceipt: 'unverified',
  }
}

/** Consume only display fields; never retain questions, answers, receipts or raw events. */
export function parseApplicationTasks(value: unknown, userId: string): { tasks: ApplicationTaskView[]; limited: boolean } | null {
  const payload = record(value)
  if (!userId || !Array.isArray(payload?.tasks) || payload.tasks.length > 100) return null
  const byJobId = new Map<string, ApplicationTaskView>()
  for (const value of payload.tasks) {
    const row = record(value)
    const job = record(row?.job)
    if (!row || !job || row.userId !== userId || !identifier(row.id) || !identifier(row.jobId)
      || !displayText(row.status) || !displayText(job?.company) || !displayText(job?.role)
      || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return null
    const task: ApplicationTaskView = {
      id: row.id, jobId: row.jobId, sessionId: identifier(row.sessionId) ? row.sessionId : null,
      status: row.status, checkpoint: typeof row.checkpoint === 'string' ? row.checkpoint : null,
      company: job.company, role: job.role, updatedAt: row.updatedAt,
      submissionEvidence: submissionEvidence(row.submissionEvidence, row.status, typeof row.checkpoint === 'string' ? row.checkpoint : null),
    }
    const previous = byJobId.get(task.jobId)
    if (previous) return null
    byJobId.set(task.jobId, task)
  }
  return { tasks: [...byJobId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), limited: payload.tasks.length === 100 }
}

/** These are display states, not a new execution state machine or submission authority. */
export function getApplicationTaskState(task: ApplicationTaskView): ApplicationTaskState {
  let kind: ApplicationTaskKind
  if (task.checkpoint === 'submission_uncertain' || task.status === 'unknown') kind = 'unknown'
  else if (task.status === 'submitted') kind = 'submitted'
  else if (task.checkpoint === 'submission_request_started') kind = 'submitting'
  else if (task.status === 'waiting_for_user' && task.checkpoint === 'fill_outcome_uncertain') kind = 'fillUncertain'
  else if (task.status === 'waiting_for_user' && task.checkpoint === 'materials_ready') kind = 'needsMaterialsReview'
  else if (task.status === 'waiting_for_user' && task.checkpoint === 'user_takeover') kind = 'needsHandoff'
  else if (task.status === 'waiting_for_user' && task.checkpoint === 'form_answer_required') kind = 'needsInput'
  else if (task.status === 'waiting_for_user') kind = 'needsUserAction'
  else if (task.status === 'waiting_for_authorization') kind = 'needsApproval'
  else if (task.status === 'filling') kind = 'filling'
  else if (['discovered', 'analyzing', 'generating_materials'].includes(task.status)) kind = 'preparing'
  else if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'skipped') kind = task.status
  else kind = 'unavailable'
  const needsAttention = ['needsInput', 'needsMaterialsReview', 'needsHandoff', 'needsUserAction', 'fillUncertain', 'needsApproval', 'unknown', 'failed'].includes(kind)
  const action = kind === 'needsInput' ? 'openQuestion' : kind === 'needsMaterialsReview' ? 'openMaterialsReview' : kind === 'needsHandoff' ? 'openHandoff' : kind === 'needsApproval' ? 'openReview' : kind === 'unknown' ? 'checkOutcome' : 'viewActivity'
  return { kind, needsAttention, labelKey: `jobs.task.${kind}`, descriptionKey: `jobs.task.${kind}Hint`, actionKey: `jobs.task.${action}` }
}

export function applicationTaskSessionHref(task: ApplicationTaskView): string | null {
  return identifier(task.sessionId) ? `/?page=agent&sessionId=${encodeURIComponent(task.sessionId)}` : null
}
