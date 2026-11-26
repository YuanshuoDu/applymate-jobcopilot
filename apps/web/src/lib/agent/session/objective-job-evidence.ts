import type { Prisma } from '@prisma/client'

import { parseObjectiveVerifiedSourceResultForRead } from '../broker/objective-application-review-source-verification'
import { readObjectiveJourneyProofContext, type ObjectiveJourneyProofContext } from './objective-journey-report-source'
import {
  isSafeObjectiveJobPostingUrl, OBJECTIVE_JOB_EVIDENCE_SCHEMA, type ObjectiveJobEvidence,
  type ObjectiveJobEvidenceGroup, parseObjectiveJobEvidence,
} from './objective-job-evidence-contract'

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type JobRole = 'scout' | 'analyst'
type JobFact = Readonly<{ jobId: string }>
const MAX_JOBS = 256
const GROUP_ROLE: Readonly<Record<ObjectiveJobEvidenceGroup, JobRole>> = { discoveredJobs: 'scout', analyzedJobs: 'analyst' }

export async function readObjectiveJobEvidence(tx: Tx, input: Readonly<{
  userId: string; sessionId: string; finalItemId: string; graphRevision: number; group: ObjectiveJobEvidenceGroup
}>): Promise<ObjectiveJobEvidence | undefined> {
  if (!Number.isSafeInteger(input.graphRevision) || input.graphRevision < 1 || !input.group) return undefined
  const context = await readObjectiveJourneyProofContext(tx, input, input.graphRevision)
  if (!context?.sourceGroups) return undefined
  const expected = sourceCount(context.sidecar, input.group), sourceKeys = context.sourceGroups.groups[input.group]
  if (!expected || expected.knownCount === null || expected.knownCount < 1 || expected.knownCount > MAX_JOBS
    || !['complete', 'partial'].includes(expected.coverage) || sourceKeys.length < 1 || sourceKeys.length > 8) return undefined

  const role = GROUP_ROLE[input.group], sourceByKey = new Map(context.manifest.sources.map(source => [source.sourceKey, source]))
  const historical = context.manifest.schemaVersion === 'agent-harness.v2.task-graph-sources.v2'
    ? new Set(context.manifest.historicalNodeIndices) : new Set<number>()
  const jobs = new Map<string, { sourceKeys: string[] }>()
  for (const sourceKey of sourceKeys) {
    const source = sourceByKey.get(sourceKey), node = source && context.progress.nodes[source.nodeIndex]
    const task = node && context.tasks.get(node.taskId)
    if (!source || !node || historical.has(source.nodeIndex) || source.role !== role || source.resultState !== 'valid'
      || source.taskStatus !== 'completed' || node.templateId !== role || !task || task.id !== node.taskId
      || task.parentTaskId !== context.rootTaskId || task.role !== role || task.taskType !== taskType(role) || task.status !== 'completed') return undefined
    const result = parseObjectiveVerifiedSourceResultForRead(task.result, role, task.id)
    if (!result || result.status !== source.roleResultStatus) return undefined
    const facts = roleFacts(result, role)
    if (!facts) return undefined
    for (const fact of facts) {
      const existing = jobs.get(fact.jobId)
      if (existing) { if (!existing.sourceKeys.includes(sourceKey)) existing.sourceKeys.push(sourceKey) }
      else jobs.set(fact.jobId, { sourceKeys: [sourceKey] })
      if (jobs.size > MAX_JOBS) return undefined
    }
  }
  if (jobs.size !== expected.knownCount || jobs.size < 1) return undefined
  const jobIds = [...jobs.keys()]
  const rows = await tx.job.findMany({ where: { userId: input.userId, id: { in: jobIds } }, take: jobIds.length + 1,
    select: { id: true, userId: true, company: true, role: true, location: true, url: true } })
  if (rows.length !== jobIds.length) return undefined
  const byId = new Map<string, Row>()
  for (const value of rows) {
    const row = record(value)
    if (!row || !safeId(row.id) || byId.has(row.id) || row.userId !== input.userId || !jobIds.includes(row.id)) return undefined
    byId.set(row.id, row)
  }
  if (byId.size !== jobIds.length) return undefined
  const evidence = jobIds.map((jobId, index) => {
    const row = byId.get(jobId), company = row && typeof row.company === 'string' && label(row.company, 160) ? row.company : undefined
    const title = row && typeof row.role === 'string' && label(row.role, 160) ? row.role : undefined
    const location = row && nullableLabel(row.location, 256)
    if (!row || !company || !title || location === undefined) return undefined
    return { ordinal: index + 1, role: title, company, location, postingUrl: safePostingUrl(row.url), sourceKeys: jobs.get(jobId)!.sourceKeys }
  })
  if (evidence.some(item => !item)) return undefined
  return parseObjectiveJobEvidence({ schemaVersion: OBJECTIVE_JOB_EVIDENCE_SCHEMA, graphRevision: input.graphRevision,
    group: input.group, coverage: expected.coverage, count: evidence.length, jobs: evidence })
}

function sourceCount(sidecar: ObjectiveJourneyProofContext['sidecar'], group: ObjectiveJobEvidenceGroup) {
  return 'sourceCounts' in sidecar ? sidecar.sourceCounts[group] : undefined
}
function taskType(role: JobRole): 'job_discovery' | 'job_analysis' { return role === 'scout' ? 'job_discovery' : 'job_analysis' }
function roleFacts(result: Row, role: JobRole): JobFact[] | undefined {
  const listKey = role === 'scout' ? 'candidates' : 'findings'
  if (!exact(result, ['evidence', 'role', 'schemaVersion', 'status', listKey, 'summary']) || result.role !== role
    || (result.status !== 'completed' && result.status !== 'partial') || typeof result.summary !== 'string' || result.summary.length > 8_192) return undefined
  const evidence = dense(result.evidence, 256), evidenceById = new Map<string, Row>()
  if (!evidence) return undefined
  for (const value of evidence) {
    const row = record(value)
    if (!row || !exact(row, ['id', 'kind', 'ref', 'source']) || !safeId(row.id) || !label(row.source, 256)
      || !['job', 'persona', 'resume', 'source'].includes(String(row.kind)) || evidenceById.has(row.id)) return undefined
    evidenceById.set(row.id, row)
  }
  const items = dense(result[listKey], 256), facts: JobFact[] = []
  if (!items) return undefined
  for (const value of items) {
    const row = record(value), ids = row && dense(row.evidenceIds, 50)
    const evidenceIds = ids && ids.length > 0 && ids.every(safeId) ? ids : undefined
    if (!row || !evidenceIds || !exact(row, role === 'scout' ? ['evidenceIds', 'jobId', 'source', 'url'] : ['evidenceIds', 'jobId', 'score'])
      || !safeId(row.jobId) || new Set(evidenceIds).size !== evidenceIds.length
      || role === 'scout' && (row.url !== null && !label(row.url, 2_048) || !label(row.source, 256))
      || role === 'analyst' && (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 10)) return undefined
    let linked = false
    for (const id of evidenceIds) {
      const evidence = evidenceById.get(id)
      if (!evidence) return undefined
      if (evidence.kind === 'job' && evidence.ref === row.jobId) linked = true
    }
    if (!linked) return undefined
    facts.push({ jobId: row.jobId })
  }
  return facts
}
function safePostingUrl(value: unknown): string | null {
  return isSafeObjectiveJobPostingUrl(value) ? value : null
}
function label(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function nullableLabel(value: unknown, maximum: number): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  return value.trim() === '' ? null : value.trim() === value ? value : undefined
}
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && value.trim() === value }
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try { const keys = Reflect.ownKeys(value); return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) ? value as Row : undefined } catch { return undefined }
}
function exact(row: Row, keys: readonly string[]): boolean { return Reflect.ownKeys(row).length === keys.length && Object.keys(row).sort().join(',') === [...keys].sort().join(',') }
function dense(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key)))) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined; result.push(descriptor.value) }
  return result
}
