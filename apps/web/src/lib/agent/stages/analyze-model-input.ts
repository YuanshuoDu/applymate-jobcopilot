import { createHash } from 'node:crypto'
import type { Job, Prisma } from '@prisma/client'
import { stripFences, type ChatMessage } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'
import { acquireSourceMaterialFence } from '../source-material-fence'
import { resumeToText, type AcceptResult, type AnalyzeOutput, type ScoredJob, type StageResult } from '../types'

export class AnalyzeSourceChangedError extends Error {
  readonly code = 'scheduled_pipeline_source_changed'

  constructor() {
    super('Analyze source material changed while scoring; retry with current Job and Resume inputs.')
    this.name = 'AnalyzeSourceChangedError'
    Object.defineProperty(this, 'name', { enumerable: false })
    Object.defineProperty(this, 'code', { enumerable: false })
  }
}

export type AnalyzeSourceFingerprint = Readonly<{
  version: 'agent-harness.v2.analyze-source-input.v1'
  digest: string
}>

export type AnalyzeSourceChangedClaim = Readonly<{ jobId: string; analysisFenceAt: string }>
const SOURCE_FINGERPRINT_VERSION = 'agent-harness.v2.analyze-source-input.v1' as const
const SOURCE_FINGERPRINT_DOMAIN = 'agent-harness.v2.analyze-source-input.v1'
export const MAX_ANALYZE_SOURCE_CHANGE_CLAIMS = 128
const sourceChangeClaimsByError = new WeakMap<object, readonly AnalyzeSourceChangedClaim[] | null>()

export function isAnalyzeSourceChangedError(error: unknown): error is AnalyzeSourceChangedError {
  if (!(error instanceof Error) && (!error || typeof error !== 'object')) return false
  const row = error as { name?: unknown; code?: unknown }
  return row.name === 'AnalyzeSourceChangedError' && row.code === 'scheduled_pipeline_source_changed'
}

export function attachAnalyzeSourceChangedClaims(error: unknown, claims: readonly { jobId: string; analysisFenceAt: Date }[], maxClaims: number): boolean {
  if (!isAnalyzeSourceChangedError(error)) return false
  const normalized = normalizeAnalyzeSourceChangedClaims(claims, maxClaims)
  if (!normalized) {
    if (!sourceChangeClaimsByError.has(error)) sourceChangeClaimsByError.set(error, null)
    return false
  }
  if (sourceChangeClaimsByError.has(error)) {
    const existing = sourceChangeClaimsByError.get(error)
    return Boolean(existing && sameAnalyzeSourceChangedClaims(existing, normalized))
  }
  sourceChangeClaimsByError.set(error, normalized)
  return true
}

export function createAnalyzeSourceChangedErrorWithClaims(claims: readonly AnalyzeSourceChangedClaim[], maxClaims = Array.isArray(claims) ? claims.length : 0): AnalyzeSourceChangedError {
  const error = new AnalyzeSourceChangedError()
  const normalized = normalizeAnalyzeSourceChangedClaims(claims, maxClaims)
  if (!normalized) { sourceChangeClaimsByError.set(error, null); return error }
  sourceChangeClaimsByError.set(error, normalized)
  return error
}

export function readAnalyzeSourceChangedClaims(error: unknown): readonly AnalyzeSourceChangedClaim[] | null {
  if (!isAnalyzeSourceChangedError(error)) return null
  return sourceChangeClaimsByError.get(error) ?? null
}

function normalizeAnalyzeSourceChangedClaims(claims: readonly unknown[], maxClaims: number): readonly AnalyzeSourceChangedClaim[] | null {
  if (!Array.isArray(claims) || !Number.isSafeInteger(maxClaims) || maxClaims < 0 || maxClaims > MAX_ANALYZE_SOURCE_CHANGE_CLAIMS
    || claims.length > maxClaims) return null
  const seen = new Set<string>(), normalized: AnalyzeSourceChangedClaim[] = []
  for (const value of claims) {
    const claim = record(value), jobId = claim?.jobId, rawFence = claim?.analysisFenceAt
    if (!claim || Object.keys(claim).sort().join(',') !== 'analysisFenceAt,jobId'
      || typeof jobId !== 'string' || !jobId || jobId.trim() !== jobId || jobId.length > 256) return null
    const fence = rawFence instanceof Date ? rawFence : typeof rawFence === 'string' ? new Date(rawFence) : null
    if (!fence || !Number.isFinite(fence.getTime()) || typeof rawFence === 'string' && fence.toISOString() !== rawFence || seen.has(jobId)) return null
    seen.add(jobId)
    normalized.push(Object.freeze({ jobId, analysisFenceAt: fence.toISOString() }))
  }
  return Object.freeze(normalized)
}

function sameAnalyzeSourceChangedClaims(left: readonly AnalyzeSourceChangedClaim[], right: readonly AnalyzeSourceChangedClaim[]): boolean {
  return left.length === right.length && left.every((claim, index) =>
    claim.jobId === right[index]?.jobId && claim.analysisFenceAt === right[index]?.analysisFenceAt)
}

export function isAnalyzeSourceFingerprint(value: unknown): value is AnalyzeSourceFingerprint {
  const row = record(value)
  return Boolean(row && Object.keys(row).sort().join(',') === 'digest,version'
    && row.version === SOURCE_FINGERPRINT_VERSION && typeof row.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest))
}

export function hasCompleteAnalyzeSourceFingerprints(jobIds: readonly string[], fingerprints: unknown): fingerprints is Readonly<Record<string, AnalyzeSourceFingerprint>> {
  const ids = [...jobIds]
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256) || new Set(ids).size !== ids.length) return false
  const row = record(fingerprints)
  if (ids.length === 0) return fingerprints === undefined || Boolean(row && Object.keys(row).length === 0)
  if (!row) return false
  const keys = Object.keys(row).sort(), expected = ids.sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index] && isAnalyzeSourceFingerprint(row[key]))
}

export function createAnalyzeSourceFingerprint(input: {
  userId: string; jobId: string; job: AnalyzeJobInputs; resumeId: string; resumeText: string
}): AnalyzeSourceFingerprint {
  const promptExcerptDigest = createHash('sha256').update(input.resumeText.slice(0, 2000), 'utf8').digest('hex')
  const canonical = JSON.stringify([
    SOURCE_FINGERPRINT_DOMAIN, SOURCE_FINGERPRINT_VERSION, input.userId, input.jobId,
    input.job.company, input.job.role, input.job.location, input.job.description, input.job.source, input.job.url,
    input.resumeId, promptExcerptDigest,
  ])
  return Object.freeze({ version: SOURCE_FINGERPRINT_VERSION, digest: createHash('sha256').update(canonical, 'utf8').digest('hex') })
}

/** Re-reads current inputs under one caller-owned source-fenced transaction and validates persisted scores. */
export async function validateAnalyzeSourceFingerprints(tx: Prisma.TransactionClient, input: {
  userId: string; resumeId: string; resumeText: string; jobIds: readonly string[]; sourceFingerprintsByJob: unknown
  claimTokens?: readonly AnalyzeSourceChangedClaim[]
}): Promise<Readonly<Record<string, AnalyzeSourceFingerprint>>> {
  await acquireSourceMaterialFence(tx, [input.userId])
  const expected = input.sourceFingerprintsByJob
  if (!hasCompleteAnalyzeSourceFingerprints(input.jobIds, expected)) throw changedInput(input.claimTokens)
  const resume = await currentResumeForUser(tx, input.userId)
  if (!resume || resume.id !== input.resumeId) throw changedInput(input.claimTokens)
  const resumeText = resumeToText(resume.content as unknown as ResumeContent).slice(0, 2000)
  if (resumeText !== input.resumeText.slice(0, 2000)) throw changedInput(input.claimTokens)

  const current: Record<string, AnalyzeSourceFingerprint> = {}
  for (const jobId of [...input.jobIds].sort()) {
    const job = await tx.job.findFirst({ where: { id: jobId, userId: input.userId }, select: JOB_INPUT_SELECT })
    if (!job) throw changedInput(input.claimTokens)
    const fingerprint = createAnalyzeSourceFingerprint({ userId: input.userId, jobId, job, resumeId: resume.id, resumeText })
    if (fingerprint.digest !== expected[jobId]?.digest) throw changedInput(input.claimTokens)
    current[jobId] = fingerprint
  }
  return Object.freeze(current)
}

function changedInput(claims?: readonly AnalyzeSourceChangedClaim[]): AnalyzeSourceChangedError {
  return claims ? createAnalyzeSourceChangedErrorWithClaims(claims) : new AnalyzeSourceChangedError()
}

const JOB_INPUT_SELECT = { company: true, role: true, location: true, description: true, source: true, url: true } as const
type AnalyzeJobInputs = Pick<Job, 'company' | 'role' | 'location' | 'description' | 'source' | 'url'>

export function buildScorePrompt(resumeText: string, job: Job): string {
  return `You are an expert ATS analyzer. Score this resume-job fit.

IMPORTANT: Output ONLY the JSON object below. No explanation, no preamble, no markdown fences.

RESUME (excerpt):
${resumeText.slice(0, 2000)}

JOB: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `DESCRIPTION:\n${job.description.slice(0, 1000)}` : '(no description — score based on role/company only)'}

Output this exact JSON structure:
{"score":75,"matchedKeywords":["skill1","skill2"],"missingKeywords":["skill3"],"recommendation":"One actionable sentence."}

Now output the JSON for this specific job:`
}

export function buildAnalyzeMessages(resumeText: string, job: Job, systemPrompt?: string): ChatMessage[] {
  const userMessage: ChatMessage = { role: 'user', content: buildScorePrompt(resumeText, job) }
  return systemPrompt ? [{ role: 'system', content: systemPrompt }, userMessage] : [userMessage]
}

export function analyzeScoreColor(score: number): string {
  return score >= 80 ? '#3B6D11' : score >= 60 ? '#854F0B' : '#6B7280'
}

export function parseScoreResult(raw: string): Omit<ScoredJob, 'job'> {
  const stripped = stripFences(raw)
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI returned no JSON score')

  let result: Record<string, unknown>
  try { result = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown> }
  catch { throw new Error('AI returned malformed score JSON') }

  const score = Number(result.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('AI returned an invalid match score')

  return {
    score: Math.round(score),
    matchedKeywords: Array.isArray(result.matchedKeywords) ? result.matchedKeywords.filter((value): value is string => typeof value === 'string') : [],
    missingKeywords: Array.isArray(result.missingKeywords) ? result.missingKeywords.filter((value): value is string => typeof value === 'string') : [],
    recommendation: typeof result.recommendation === 'string' ? result.recommendation : '',
  }
}

export function acceptAnalyze(result: StageResult<AnalyzeOutput>): AcceptResult {
  if (!result.ok || !result.data) return { ok: false, reason: result.error ?? 'Analyze returned no data' }
  for (const scored of result.data.scoredJobs) {
    if (typeof scored.score !== 'number' || scored.score < 0 || scored.score > 100) {
      return { ok: false, reason: `Job ${scored.job.id} has invalid score: ${scored.score}` }
    }
    if (!Array.isArray(scored.matchedKeywords)) return { ok: false, reason: `Job ${scored.job.id} missing matchedKeywords array` }
  }
  return { ok: true }
}

/** Fences and revalidates the exact source inputs before Analyze writes a score. */
export async function assertAnalyzeModelInputsCurrent(tx: Prisma.TransactionClient, input: {
  userId: string
  job: Job
  resumeId: string
  resumeText: string
}): Promise<AnalyzeSourceFingerprint> {
  await acquireSourceMaterialFence(tx, [input.userId])

  const currentJob = await tx.job.findFirst({
    where: { id: input.job.id, userId: input.userId },
    select: JOB_INPUT_SELECT,
  })
  if (!currentJob || !sameJobInputs(input.job, currentJob)) throw new AnalyzeSourceChangedError()

  const currentResume = await currentResumeForUser(tx, input.userId)
  if (!currentResume || currentResume.id !== input.resumeId) throw new AnalyzeSourceChangedError()

  const currentResumeText = resumeToText(currentResume.content as unknown as ResumeContent).slice(0, 2000)
  if (currentResumeText !== input.resumeText.slice(0, 2000)) throw new AnalyzeSourceChangedError()
  return createAnalyzeSourceFingerprint({ userId: input.userId, jobId: input.job.id, job: currentJob, resumeId: currentResume.id, resumeText: currentResumeText })
}

async function currentResumeForUser(tx: Prisma.TransactionClient, userId: string) {
  const selection = { where: { userId }, select: { id: true, content: true } } as const
  return await tx.resume.findFirst({ ...selection, where: { ...selection.where, isDefault: true } })
    ?? await tx.resume.findFirst({ ...selection, orderBy: { createdAt: 'desc' } })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sameJobInputs(job: AnalyzeJobInputs, current: AnalyzeJobInputs): boolean {
  return job.company === current.company && job.role === current.role && job.location === current.location
    && job.description === current.description && job.source === current.source && job.url === current.url
}
