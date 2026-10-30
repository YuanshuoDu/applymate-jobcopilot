export interface ApplicationTaskView {
  id: string
  jobId: string
  sessionId: string | null
  status: string
  checkpoint: string | null
  company: string
  role: string
  updatedAt: string
}

export type ApplicationTaskKind = 'preparing' | 'filling' | 'needsInput' | 'needsApproval' | 'submitting' | 'submitted' | 'unknown' | 'failed' | 'cancelled' | 'skipped' | 'unavailable'

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
    }
    const previous = byJobId.get(task.jobId)
    if (previous && Date.parse(previous.updatedAt) === Date.parse(task.updatedAt)
      && (previous.id !== task.id || previous.status !== task.status || previous.sessionId !== task.sessionId || previous.checkpoint !== task.checkpoint)) return null
    if (!previous || Date.parse(task.updatedAt) > Date.parse(previous.updatedAt)) byJobId.set(task.jobId, task)
  }
  return { tasks: [...byJobId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), limited: payload.tasks.length === 100 }
}

/** These are display states, not a new execution state machine or submission authority. */
export function getApplicationTaskState(task: ApplicationTaskView): ApplicationTaskState {
  let kind: ApplicationTaskKind
  if (task.checkpoint === 'submission_uncertain' || task.status === 'unknown') kind = 'unknown'
  else if (task.status === 'submitted') kind = 'submitted'
  else if (task.checkpoint === 'submission_request_started') kind = 'submitting'
  else if (task.status === 'waiting_for_user') kind = 'needsInput'
  else if (task.status === 'waiting_for_authorization') kind = 'needsApproval'
  else if (task.status === 'filling') kind = 'filling'
  else if (['discovered', 'analyzing', 'generating_materials'].includes(task.status)) kind = 'preparing'
  else if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'skipped') kind = task.status
  else kind = 'unavailable'
  const needsAttention = ['needsInput', 'needsApproval', 'unknown', 'failed'].includes(kind)
  const action = kind === 'needsInput' ? 'openQuestion' : kind === 'needsApproval' ? 'openReview' : kind === 'unknown' ? 'checkOutcome' : 'viewActivity'
  return { kind, needsAttention, labelKey: `jobs.task.${kind}`, descriptionKey: `jobs.task.${kind}Hint`, actionKey: `jobs.task.${action}` }
}

export function applicationTaskSessionHref(task: ApplicationTaskView): string | null {
  return identifier(task.sessionId) ? `/?page=agent&sessionId=${encodeURIComponent(task.sessionId)}` : null
}
