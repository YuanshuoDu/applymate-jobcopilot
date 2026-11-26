export const OBJECTIVE_JOB_EVIDENCE_SCHEMA = 'agent-harness.v2.objective-job-evidence.v1' as const
export const OBJECTIVE_JOB_EVIDENCE_GROUPS = ['discoveredJobs', 'analyzedJobs'] as const
export type ObjectiveJobEvidenceGroup = typeof OBJECTIVE_JOB_EVIDENCE_GROUPS[number]
export type ObjectiveJobEvidenceCoverage = 'complete' | 'partial'
export type ObjectiveJobEvidenceJob = Readonly<{
  ordinal: number; role: string; company: string; location: string | null; postingUrl: string | null; sourceKeys: readonly string[]
}>
export type ObjectiveJobEvidence = Readonly<{
  schemaVersion: typeof OBJECTIVE_JOB_EVIDENCE_SCHEMA; graphRevision: number; group: ObjectiveJobEvidenceGroup
  coverage: ObjectiveJobEvidenceCoverage; count: number; jobs: readonly ObjectiveJobEvidenceJob[]
}>

/** Parses only the bounded, browser-safe saved-Job evidence projection. */
export function parseObjectiveJobEvidence(value: unknown): ObjectiveJobEvidence | undefined {
  const row = record(value)
  if (!row || !exact(row, 'count,coverage,graphRevision,group,jobs,schemaVersion')
    || row.schemaVersion !== OBJECTIVE_JOB_EVIDENCE_SCHEMA || !positive(row.graphRevision)
    || !OBJECTIVE_JOB_EVIDENCE_GROUPS.includes(row.group as ObjectiveJobEvidenceGroup)
    || !['complete', 'partial'].includes(String(row.coverage)) || !count(row.count)) return undefined
  const jobs = dense(row.jobs, 256), parsed: ObjectiveJobEvidenceJob[] = []
  if (!jobs || Number(row.count) !== jobs.length || row.count === 0 && row.coverage !== 'complete') return undefined
  for (let index = 0; index < jobs.length; index += 1) {
    const job = record(jobs[index])
    if (!job || !exact(job, 'company,location,ordinal,postingUrl,role,sourceKeys') || job.ordinal !== index + 1
      || !text(job.role, 160) || !text(job.company, 160) || !nullableText(job.location, 256) || !nullableUrl(job.postingUrl)) return undefined
    const sourceKeys = dense(job.sourceKeys, 8)
    if (!sourceKeys || sourceKeys.length < 1 || !sourceKeys.every(value => safeSourceKey(value))
      || new Set(sourceKeys).size !== sourceKeys.length) return undefined
    parsed.push({ ordinal: index + 1, role: job.role, company: job.company, location: job.location as string | null,
      postingUrl: job.postingUrl as string | null, sourceKeys: [...sourceKeys] as string[] })
  }
  return { schemaVersion: OBJECTIVE_JOB_EVIDENCE_SCHEMA, graphRevision: Number(row.graphRevision), group: row.group as ObjectiveJobEvidenceGroup,
    coverage: row.coverage as ObjectiveJobEvidenceCoverage, count: Number(row.count), jobs: parsed }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== 'string')) return undefined
    if (keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') })) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}
function exact(row: Record<string, unknown>, keys: string): boolean {
  return Reflect.ownKeys(row).length === keys.split(',').length && Object.keys(row).sort().join(',') === keys.split(',').sort().join(',')
}
function dense(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key)))) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result.push(descriptor.value)
  }
  return result
}
function safeSourceKey(value: unknown): value is string { return typeof value === 'string' && /^src_[A-Za-z0-9_-]{43}$/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000 }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 256 }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function nullableText(value: unknown, maximum: number): value is string | null { return value === null || text(value, maximum) }
function nullableUrl(value: unknown): value is string | null { return value === null || isSafeObjectiveJobPostingUrl(value) }
export function isSafeObjectiveJobPostingUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || value.trim() !== value
    || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash
  } catch { return false }
}
