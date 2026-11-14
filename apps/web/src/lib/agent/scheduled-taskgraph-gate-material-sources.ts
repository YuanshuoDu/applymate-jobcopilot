import type { Job, Prisma } from '@prisma/client'
import { hashArtifactContent } from './artifacts/hash'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const ID = /^[^\u0000-\u001f\u007f]{1,256}$/

export type ScheduledTaskGraphGateMaterialSourcesReader = Pick<Prisma.TransactionClient,
  'agentSession' | 'job' | 'resume' | 'personaFact'>
export type ScheduledTaskGraphGateSourceDigestBundle = { digest: string; refs: string[]; hashes: Map<string, string> }
export type ScheduledTaskGraphGateSourceBundle = { jobs: Map<string, Job>; byJob: Map<string, ScheduledTaskGraphGateSourceDigestBundle> }

/** Reloads Gate source rows through the supplied reader and builds their immutable digest bundles. */
export async function loadScheduledTaskGraphGateMaterialSources(reader: ScheduledTaskGraphGateMaterialSourcesReader,
  owner: ScheduledTaskGraphPipelineOwner, jobIds: readonly string[]): Promise<ScheduledTaskGraphGateSourceBundle | null> {
  if (jobIds.length === 0) return { jobs: new Map(), byJob: new Map() }
  const session = await reader.agentSession.findFirst({ where: { id: owner.sessionId, userId: owner.userId }, select: { id: true } })
  if (!session) return null
  const [jobs, resume, facts] = await Promise.all([
    reader.job.findMany({ where: { userId: owner.userId, id: { in: [...jobIds] } } }),
    reader.resume.findFirst({ where: { userId: owner.userId, kind: 'base' }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, kind: true, origin: true, isDefault: true, content: true, createdAt: true, updatedAt: true } }),
    reader.personaFact.findMany({ where: { userId: owner.userId, status: 'confirmed', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], allowedUses: { has: 'cover_letter' } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 50,
      select: { id: true, key: true, category: true, value: true, source: true, sourceRef: true, confidence: true, allowedUses: true } }),
  ])
  if (!resume || !validResume(resume) || jobs.length !== jobIds.length || facts.some(fact => !validPersonaFact(fact))) return null
  const jobMap = uniqueMap(jobs, job => job.id)
  if (!jobMap || jobIds.some(id => !jobMap.has(id) || jobMap.get(id)?.userId !== owner.userId)) return null
  const normalizedFacts = facts.map(fact => ({ ...fact, confidence: Number(fact.confidence), allowedUses: [...fact.allowedUses] }))
  const byJob = new Map<string, ScheduledTaskGraphGateSourceDigestBundle>()
  for (const id of jobIds) {
    const job = jobMap.get(id)!, jobSource = workerJob(job)
    const resumeSource = { id: resume.id, name: resume.name, kind: resume.kind, origin: resume.origin, isDefault: resume.isDefault,
      content: resume.content, createdAt: toIso(resume.createdAt), updatedAt: toIso(resume.updatedAt) }
    const sources = [
      { sourceRef: `job:${id}`, content: jobSource }, { sourceRef: `resume:${resume.id}`, content: resumeSource },
      ...normalizedFacts.map((fact, index) => ({ sourceRef: `persona:${fact.id}`, content: { ...fact, rank: index + 1 } })),
    ].map(item => ({ sourceRef: item.sourceRef, contentHash: hashArtifactContent(item.content) })).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))
    if (new Set(sources.map(item => item.sourceRef)).size !== sources.length) return null
    byJob.set(id, { digest: hashArtifactContent({ jobId: id, sources }), refs: sources.map(item => item.sourceRef),
      hashes: new Map(sources.map(item => [item.sourceRef, item.contentHash])) })
  }
  return { jobs: jobMap, byJob }
}

function workerJob(job: Job): Record<string, unknown> {
  return { id: job.id, company: job.company, role: job.role, location: job.location ?? null, status: job.status,
    score: job.score ?? null, url: job.url ?? null, source: job.source ?? null, salary: job.salary ?? null,
    description: job.description ?? null, keywords: job.keywords ?? null }
}
function validResume(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && validId(row.id) && typeof row.name === 'string' && row.kind === 'base' && typeof row.origin === 'string'
    && typeof row.isDefault === 'boolean' && validDate(row.createdAt) && validDate(row.updatedAt))
}
function validPersonaFact(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && [row.id, row.key, row.category, row.value, row.source].every(item => typeof item === 'string')
    && validId(row.id) && (row.sourceRef === null || typeof row.sourceRef === 'string')
    && typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    && Array.isArray(row.allowedUses) && row.allowedUses.every(item => typeof item === 'string'))
}
function toIso(value: Date | string): string { return (value instanceof Date ? value : new Date(value)).toISOString() }
function validDate(value: unknown): value is Date | string { return value instanceof Date && Number.isFinite(value.getTime()) || typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function uniqueMap<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> | null {
  const map = new Map<string, T>()
  for (const row of rows) { const id = key(row); if (map.has(id)) return null; map.set(id, row) }
  return map
}
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
