type ApplyResultRecord = {
  id: number
  userId: string
  jobId: string
  status: string
  mode: string
  atsType: string | null
  flowUsed: string | null
  error: string | null
  durationMs: number | null
  createdAt: Date
}

export function applicationErrorClass(error: string | null) {
  const normalized = error?.toLowerCase() ?? ''
  if (!normalized) return null
  if (normalized.includes('captcha')) return 'captcha'
  if (normalized.includes('timeout')) return 'timeout'
  if (normalized.includes('validation')) return 'validation'
  if (normalized.includes('network') || normalized.includes('connection')) return 'network'
  return 'unknown'
}

export function toAdminApplicationMetadata(result: ApplyResultRecord) {
  return {
    id: result.id,
    userId: result.userId,
    jobId: result.jobId,
    status: result.status,
    mode: result.mode,
    atsType: result.atsType ?? 'unknown',
    flowUsed: result.flowUsed ?? 'unknown',
    errorClass: applicationErrorClass(result.error),
    durationMs: result.durationMs,
    createdAt: result.createdAt,
  }
}

type ApplicationTaskSummaryRecord = {
  id: string
  userId: string
  jobId: string
  status: string
  checkpoint: string | null
  error: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  job: { company: string; role: string; source: string | null }
}

/**
 * The durable task is the administrator's source of truth. ApplyResult is only
 * the latest execution outcome and may legitimately be absent while a task is
 * waiting, running, skipped, or cancelled.
 */
export function toAdminApplicationTaskSummary(task: ApplicationTaskSummaryRecord, result: ApplyResultRecord | null) {
  const outcome = result ? toAdminApplicationMetadata(result) : null
  return {
    id: task.id,
    userId: task.userId,
    jobId: task.jobId,
    company: task.job.company,
    role: task.job.role,
    source: task.job.source ?? 'unknown',
    status: task.status,
    checkpoint: task.checkpoint,
    errorClass: applicationErrorClass(task.error),
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    resultId: outcome?.id ?? null,
    resultStatus: outcome?.status ?? null,
    mode: outcome?.mode ?? null,
    atsType: outcome?.atsType ?? null,
    flowUsed: outcome?.flowUsed ?? null,
    resultErrorClass: outcome?.errorClass ?? null,
    durationMs: outcome?.durationMs ?? null,
    resultCreatedAt: outcome?.createdAt ?? null,
  }
}

type ApplicationTaskEventRecord = {
  id: string
  type: string
  actor: string
  createdAt: Date
}

type ApplicationTaskRecord = {
  id: string
  status: string
  checkpoint: string | null
  error: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  events: ApplicationTaskEventRecord[]
}

export function applicationTaskCounts(rows: Array<{ status: string; _count: { _all: number } }>) {
  const counts = new Map(rows.map(row => [row.status, Number(row._count._all)]))
  const count = (...statuses: string[]) => statuses.reduce((total, status) => total + (counts.get(status) ?? 0), 0)
  return {
    total: [...counts.values()].reduce((total, value) => total + value, 0),
    needsAttention: count('waiting_for_user', 'waiting_for_authorization'),
    inProgress: count('discovered', 'analyzing', 'generating_materials', 'filling'),
    submitted: count('submitted'),
    failed: count('failed'),
    skipped: count('skipped'),
    cancelled: count('cancelled'),
  }
}

const SAFE_TASK_EVENT_NOTES: Record<string, string> = {
  materials_ready: 'Application materials are ready for candidate review.',
  form_fill_queued: 'A non-submitting form-fill task was queued.',
  form_filled: 'The form was filled without submission.',
  user_takeover_required: 'Candidate takeover is required before execution can continue.',
  form_answer_required: 'Candidate input is required before execution can continue.',
  submitted: 'The worker recorded a submitted application.',
  failed: 'The worker recorded an execution failure.',
  cancelled: 'The candidate cancelled the application task.',
  cancelled_by_admin: 'An administrator cancelled the application task.',
  manual_review_requested: 'An administrator requested manual review.',
  admin_retry_requested: 'An administrator requested a retry.',
  admin_retry_failed: 'The administrator retry could not be queued.',
}

function safeTaskEventNote(type: string) {
  return SAFE_TASK_EVENT_NOTES[type] ?? 'A task state event was recorded.'
}

/**
 * Admin application views are operational-only. Worker errors and event bodies
 * can contain form prompts, candidate answers, or third-party response text,
 * so preserve only allow-listed state metadata and a deterministic safe note.
 */
export function toAdminApplicationTaskMetadata(task: ApplicationTaskRecord) {
  return {
    id: task.id,
    status: task.status,
    checkpoint: task.checkpoint,
    errorClass: applicationErrorClass(task.error),
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    events: task.events.map(event => ({
      id: event.id,
      type: event.type,
      actor: event.actor,
      body: safeTaskEventNote(event.type),
      createdAt: event.createdAt,
    })),
  }
}
