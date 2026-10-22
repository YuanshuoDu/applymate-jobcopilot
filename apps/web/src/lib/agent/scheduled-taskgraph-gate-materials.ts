import type { Job } from '@prisma/client'
import { db } from '@/lib/db'
import { hashArtifactContent } from './artifacts/hash'
import type { ArtifactKind, ArtifactProvenance, ArtifactSummary } from './artifacts/types'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ScheduledTaskGraphArtifactReference, ScheduledTaskGraphPreparedMaterialRow, ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import type { ApplicationPackage, ScoredJob } from './types'

const VERSION_SELECT = { id: true, artifactId: true, version: true, userId: true, sessionId: true, jobId: true, artifactType: true,
  content: true, contentHash: true, sourceDigest: true, constraintHash: true, provenanceRefs: true, evidenceRefs: true,
  baseId: true, baseHash: true, taskId: true, toolCallId: true, requestHash: true } as const
const HEAD_SELECT = { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, baseId: true, baseHash: true,
  content: true, hash: true, constraintHash: true, provenanceRefs: true, evidenceRefs: true, version: true } as const
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

type PreparedJob = { jobId: string; status: string }
type PreparedMaterial = { jobId: string; kind: ArtifactKind; artifactRef: ScheduledTaskGraphArtifactReference }
type SourceDigestBundle = { digest: string; refs: string[]; hashes: Map<string, string> }
type SourceBundle = { jobs: Map<string, Job>; byJob: Map<string, SourceDigestBundle> }
type ScheduledArtifactSummary = ArtifactSummary & { readonly sourceDigest: string }

export type ScheduledTaskGraphGateMaterials = Readonly<{
  packages: readonly ScheduledTaskGraphPreparedPackageRow[]
  materials: readonly ScheduledTaskGraphPreparedMaterialRow[]
}>

/** Reloads the exact source and artifact rows named by a verified prepare result and builds Gate packages. */
export async function loadScheduledTaskGraphGateMaterials(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  scoredJobs: unknown
  minScore: number
  dailyCap: number
  taskId: string
  jobs: readonly PreparedJob[]
  materials: readonly PreparedMaterial[]
}>): Promise<ScheduledTaskGraphGateMaterials | null> {
  try {
    const scores = parseScores(input.scoredJobs, input.owner.userId)
    if (!scores) return null
    const eligible = scores.filter(item => item.score >= input.minScore).slice(0, input.dailyCap)
    if (!sameIds(input.jobs.map(job => job.jobId), eligible.map(item => item.job.id))) return null
    const preparedIds = new Set(input.jobs.filter(job => job.status === 'prepared').map(job => job.jobId))
    if (!validateMaterials(input.materials, input.jobs, preparedIds)) return null
    if (input.materials.length === 0) return { packages: [], materials: [] }

    const sources = await loadCurrentSources(input.owner, [...preparedIds])
    if (!sources) return null
    const refs = input.materials.map(item => ({ ...item, ref: item.artifactRef }))
    const [versions, heads] = await Promise.all([
      db.agentArtifactVersion.findMany({
        where: { userId: input.owner.userId, sessionId: input.owner.sessionId, OR: refs.map(item => ({ jobId: item.jobId,
          artifactId: item.ref.artifactId, version: item.ref.version, artifactType: item.kind })) },
        select: VERSION_SELECT,
      }),
      db.agentArtifact.findMany({
        where: { userId: input.owner.userId, OR: refs.map(item => ({ jobId: item.jobId, id: item.ref.artifactId, artifactType: item.kind })) },
        select: HEAD_SELECT,
      }),
    ])
    if (versions.length !== refs.length || heads.length !== refs.length) return null

    const byScore = new Map(scores.map(score => [score.job.id, score]))
    const byVersion = uniqueMap(versions, row => versionKey(row.jobId, row.artifactId, row.version, row.artifactType))
    const byHead = uniqueMap(heads, row => headKey(row.jobId, row.id, row.artifactType))
    if (!byVersion || !byHead) return null
    const materialRows: ScheduledTaskGraphPreparedMaterialRow[] = []
    const packages: ScheduledTaskGraphPreparedPackageRow[] = []
    for (const candidate of eligible) {
      const jobId = candidate.job.id
      if (!preparedIds.has(jobId)) continue
      const score = byScore.get(jobId), current = sources.jobs.get(jobId)
      if (!score || !current) return null
      const artifacts = input.materials.filter(item => item.jobId === jobId)
      const built = new Map<ArtifactKind, { summary: ArtifactSummary; body: unknown; ref: ScheduledTaskGraphArtifactReference }>()
      for (const material of artifacts) {
        const ref = material.artifactRef, key = versionKey(jobId, ref.artifactId, ref.version, material.kind)
        const version = byVersion.get(key), head = byHead.get(headKey(jobId, ref.artifactId, material.kind))
        const source = sources.byJob.get(jobId)
        if (!version || !head || !source || built.has(material.kind)
          || !verifyArtifact(version, head, input.owner, jobId, material.kind, input.taskId, ref, source)) return null
        const summary = artifactSummary(version, material.kind, source)
        if (!summary) return null
        built.set(material.kind, { summary, body: version.content, ref })
        materialRows.push({ userId: input.owner.userId, sessionId: input.owner.sessionId, jobId, kind: material.kind, artifactRef: ref })
      }
      const resume = built.get('resume'), letter = built.get('cover_letter')
      if (!resume) return null
      const pkg: ApplicationPackage = {
        job: { ...current, coverLetter: null }, score: score.score, matchedKeywords: [...score.matchedKeywords],
        missingKeywords: [...score.missingKeywords], recommendation: score.recommendation,
        ...(score.analysisFenceAt ? { analysisFenceAt: score.analysisFenceAt } : {}),
        tailoredResumeId: resume.ref.artifactId, tailoredResumeName: `Tailored for ${current.company} - ${current.role}`,
        tailoredResumeArtifact: resume.summary,
        tailoredKeywords: score.missingKeywords.length ? [...score.missingKeywords] : undefined,
        ...(letter ? { coverLetter: letter.body as string, coverLetterId: letter.ref.artifactId, coverLetterArtifact: letter.summary } : {}),
      }
      packages.push({ userId: input.owner.userId, sessionId: input.owner.sessionId, jobId, package: pkg })
    }
    return { packages, materials: materialRows }
  } catch { return null }
}

function validateMaterials(materials: readonly PreparedMaterial[], jobs: readonly PreparedJob[], prepared: ReadonlySet<string>): boolean {
  const kinds = new Map<string, Set<ArtifactKind>>()
  for (const item of materials) {
    if (!prepared.has(item.jobId)) return false
    const set = kinds.get(item.jobId) ?? new Set<ArtifactKind>()
    if (set.has(item.kind)) return false
    set.add(item.kind); kinds.set(item.jobId, set)
  }
  return jobs.every(job => job.status === 'prepared'
    ? kinds.get(job.jobId)?.has('resume') === true && (kinds.get(job.jobId)?.size ?? 0) <= 2
    : !kinds.has(job.jobId))
}

function parseScores(value: unknown, userId: string): ScoredJob[] | null {
  const rows = denseArray(value)
  if (!rows) return null
  const result: ScoredJob[] = [], ids = new Set<string>()
  for (const value of rows) {
    const row = record(value), job = record(row?.job)
    if (!row || !job || !validId(job.id) || job.userId !== userId || ids.has(job.id)
      || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100
      || !stringArray(row.matchedKeywords) || !stringArray(row.missingKeywords) || typeof row.recommendation !== 'string'
      || (row.analysisFenceAt !== undefined && !validTimestamp(row.analysisFenceAt))) return null
    ids.add(job.id)
    result.push({ job: job as unknown as Job, score: row.score as number, matchedKeywords: row.matchedKeywords,
      missingKeywords: row.missingKeywords, recommendation: row.recommendation,
      ...(typeof row.analysisFenceAt === 'string' ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  return result
}

async function loadCurrentSources(owner: ScheduledTaskGraphPipelineOwner, jobIds: readonly string[]): Promise<SourceBundle | null> {
  if (jobIds.length === 0) return { jobs: new Map(), byJob: new Map() }
  const session = await db.agentSession.findFirst({ where: { id: owner.sessionId, userId: owner.userId }, select: { id: true } })
  if (!session) return null
  const [jobs, resume, facts] = await Promise.all([
    db.job.findMany({ where: { userId: owner.userId, id: { in: [...jobIds] } } }),
    db.resume.findFirst({ where: { userId: owner.userId, kind: 'base' }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, kind: true, origin: true, isDefault: true, content: true, createdAt: true, updatedAt: true } }),
    db.personaFact.findMany({ where: { userId: owner.userId, status: 'confirmed', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], allowedUses: { has: 'cover_letter' } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 50,
      select: { id: true, key: true, category: true, value: true, source: true, sourceRef: true, confidence: true, allowedUses: true } }),
  ])
  if (!resume || !validResume(resume) || jobs.length !== jobIds.length || facts.some(fact => !validPersonaFact(fact))) return null
  const jobMap = uniqueMap(jobs, job => job.id)
  if (!jobMap || jobIds.some(id => !jobMap.has(id) || jobMap.get(id)?.userId !== owner.userId)) return null
  const normalizedFacts = facts.map(fact => ({ ...fact, confidence: Number(fact.confidence), allowedUses: [...fact.allowedUses] }))
  const byJob = new Map<string, SourceDigestBundle>()
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

function verifyArtifact(versionValue: unknown, headValue: unknown, owner: ScheduledTaskGraphPipelineOwner,
  jobId: string, kind: ArtifactKind, taskId: string, ref: ScheduledTaskGraphArtifactReference, source: SourceDigestBundle): boolean {
  const version = record(versionValue), head = record(headValue)
  if (!version || !head) return false
  const provenanceRefs = parseMaterialSourceRefs(version.provenanceRefs, source, jobId)
  if (!provenanceRefs) return false
  return version.userId === owner.userId && version.sessionId === owner.sessionId && version.jobId === jobId
    && version.artifactId === ref.artifactId && version.version === ref.version && version.artifactType === kind
    && version.taskId === taskId && validId(version.toolCallId) && isDigest(version.requestHash)
    && version.contentHash === ref.contentHash && version.sourceDigest === ref.sourceDigest
    && source.digest === ref.sourceDigest && safeHash(version.content) === ref.contentHash
    && (kind !== 'cover_letter' || typeof version.content === 'string' && version.content.trim().length > 0 && version.content.length <= 20_000)
    && isDigest(version.constraintHash) && validId(version.baseId) && isDigest(version.baseHash)
    && sameOrderedStrings(version.evidenceRefs, provenanceRefs)
    && head.id === ref.artifactId && head.userId === owner.userId && head.jobId === jobId && head.artifactType === kind
    && head.lifecycle === 'draft' && head.version === ref.version && head.hash === ref.contentHash
    && (kind === 'cover_letter' ? isRedactedCoverLetterHead(head.content, ref) : safeHash(head.content) === ref.contentHash)
    && head.baseId === version.baseId && head.baseHash === version.baseHash
    && head.constraintHash === version.constraintHash && sameOrderedStrings(head.provenanceRefs, provenanceRefs)
    && sameOrderedStrings(head.evidenceRefs, provenanceRefs)
}

function isRedactedCoverLetterHead(value: unknown, ref: ScheduledTaskGraphArtifactReference): boolean {
  const marker = record(value), keys = ['kind', 'artifactId', 'version', 'contentHash']
  return Boolean(marker && Reflect.ownKeys(marker).length === keys.length
    && Reflect.ownKeys(marker).every(key => typeof key === 'string' && keys.includes(key))
    && marker.kind === 'agent_artifact_version' && marker.artifactId === ref.artifactId
    && marker.version === ref.version && marker.contentHash === ref.contentHash)
}

function parseMaterialSourceRefs(value: unknown, source: SourceDigestBundle, jobId: string): string[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64 || !value.every(ref => typeof ref === 'string')) return null
  const refs = value as string[], jobRef = `job:${jobId}`, resumeRefs = source.refs.filter(ref => ref.startsWith('resume:'))
  if (resumeRefs.length !== 1 || !source.refs.includes(jobRef) || refs.length !== new Set(refs).size
    || !refs.includes(jobRef) || !refs.includes(resumeRefs[0]!)) return null
  if (refs.some(ref => !source.refs.includes(ref) || ref !== jobRef && ref !== resumeRefs[0] && !ref.startsWith('persona:'))) return null
  const sorted = [...refs].sort()
  return refs.every((ref, index) => ref === sorted[index]) ? refs : null
}

function artifactSummary(value: unknown, kind: ArtifactKind, source: SourceDigestBundle): ScheduledArtifactSummary | null {
  const version = record(value)
  if (!version) return null
  const provenance: ArtifactProvenance[] = []
  for (const ref of version.provenanceRefs as string[]) {
    const sourceType = ref.startsWith('resume:') ? 'resume' : ref.startsWith('persona:') ? 'persona_fact' : null
    const evidenceHash = source.hashes.get(ref)
    if (sourceType && evidenceHash) provenance.push({ sourceType, sourceRef: ref, evidenceHash })
  }
  if (provenance.length === 0) return null
  return { id: version.artifactId as string, kind, lifecycle: 'draft', version: version.version as number,
    hash: version.contentHash as string, sourceDigest: version.sourceDigest as string,
    baseArtifactId: version.baseId as string, baseHash: version.baseHash as string,
    constraintHash: version.constraintHash as string, provenance }
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
function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return null
  return value
}
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
function versionKey(jobId: string, id: string, version: number, kind: string): string { return `${jobId}\0${id}\0${version}\0${kind}` }
function headKey(jobId: string, id: string, kind: string): string { return `${jobId}\0${id}\0${kind}` }
function sameIds(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && new Set(a).size === a.length && b.every(id => a.includes(id)) }
function sameOrderedStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
function isDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeHash(value: unknown): string | null { try { return hashArtifactContent(value) } catch { return null } }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
