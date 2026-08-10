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
  taskId?: string | null
  taskStatus?: string | null
  checkpoint?: string | null
}

function errorClass(error: string | null) {
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
    errorClass: errorClass(result.error),
    durationMs: result.durationMs,
    createdAt: result.createdAt,
    taskId: result.taskId ?? null,
    taskStatus: result.taskStatus ?? null,
    checkpoint: result.checkpoint ?? null,
  }
}
