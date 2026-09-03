import type { Job } from '@prisma/client'

import { db } from '@/lib/db'
import { discoverJobs, type DiscoveredJob } from './discover'
import { enrichJob } from './enrich'
import { runAnalyze } from './stages/analyze'
import type { AnalyzeOutput, PipelineCtx, StageResult } from './types'
import { DiscoveryToolError, decodeSearchCursor, encodeSearchCursor, queryFingerprint, stableJobId, type DiscoveryToolContext, type ScorePipelineContext, type ToolUsageState } from './discovery-tool-support'
import type { JobsCompareInput, JobsCompareOutput, JobsEnrichInput, JobsEnrichOutput, JobsScoreInput, JobsScoreOutput, JobsSearchInput, JobsSearchOutput, JobEvidence } from './discovery-tool-types'

export type DiscoveryToolDb = {
  job: {
    findMany(args: { where: unknown; select?: unknown }): Promise<Job[]>
  }
}

export type DiscoveryToolDependencies = {
  db?: DiscoveryToolDb
  discover?: typeof discoverJobs
  enrich?: typeof enrichJob
  analyze?: typeof runAnalyze
}

const defaultDb = db as unknown as DiscoveryToolDb

function database(deps: DiscoveryToolDependencies): DiscoveryToolDb {
  return deps.db ?? defaultDb
}

export async function executeSearch(input: JobsSearchInput, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState): Promise<Omit<JobsSearchOutput, 'usage'>> {
  const pageSize = input.pageSize ?? 10
  const baseInput = { targetRoles: input.targetRoles, targetLocations: input.targetLocations, source: input.source, pageSize }
  const fingerprint = queryFingerprint(baseInput)
  const offset = decodeSearchCursor(context.scope.userId, fingerprint, input.cursor)
  const existing = await database(deps).job.findMany({ where: { userId: context.scope.userId }, select: { url: true } })
  const existingUrls = new Set(existing.map(job => job.url).filter((url): url is string => Boolean(url)))
  const discover = deps.discover ?? discoverJobs
  const providerCalls = new Set<string>()
  const candidates = await discover({
    userId: context.scope.userId,
    targetRoles: input.targetRoles,
    targetLocations: input.targetLocations,
    existingUrls,
    maxResults: Math.min(100, Math.max(pageSize + 1, pageSize * 10)),
    onProviderCall: event => {
      providerCalls.add(event.provider)
      usage.requests += 1
      usage.providers.add(event.provider)
    },
  })
  for (const provider of providerCalls) usage.providers.add(provider)
  const filtered = input.source ? candidates.filter(job => job.source.toLowerCase() === input.source!.toLowerCase()) : candidates
  const page = filtered.slice(offset, offset + pageSize)
  usage.jobsProcessed = page.length
  usage.jobsSucceeded = page.length
  for (const job of page) usage.providers.add(job.source)
  const evidence: JobEvidence[] = []
  const jobs = page.map(job => normalizedJob(job, evidence))
  const nextCursor = offset + page.length < filtered.length ? encodeSearchCursor(context.scope.userId, fingerprint, offset + page.length) : null
  return { jobs, evidence, nextCursor }
}

function normalizedJob(job: DiscoveredJob, evidence: JobEvidence[]): JobsSearchOutput['jobs'][number] {
  const id = stableJobId(job.url, job.company, job.title, job.location)
  const evidenceId = `evidence_${id}_source`
  evidence.push({ evidenceId, jobId: id, kind: 'source', source: job.source, url: job.url, summary: `Discovered from ${job.source}; full description ${job.description ? 'available' : 'missing'}.` })
  return { id, title: job.title, company: job.company, location: job.location, url: job.url, description: job.description, fullDescription: job.description, salary: job.salary, logo: job.logo, source: job.source, evidenceRefs: [evidenceId] }
}

export async function executeEnrich(input: JobsEnrichInput, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState): Promise<Omit<JobsEnrichOutput, 'usage'>> {
  const ids = input.jobs.map(item => item.jobId)
  const rows = await loadJobs(ids, context, deps)
  const evidence: JobEvidence[] = []
  const settled = await Promise.allSettled(input.jobs.map(item => enrichOne(item, rows.get(item.jobId), context, deps, usage, evidence)))
  const results = settled.map((result, index) => result.status === 'fulfilled' ? result.value : failed(ids[index]!, 'enrichment_failed', safeMessage(result.reason)))
  usage.jobsProcessed = input.jobs.length
  usage.jobsSucceeded = results.filter(result => result.status === 'enriched').length
  usage.jobsFailed = input.jobs.length - usage.jobsSucceeded
  return { results, evidence }
}

async function enrichOne(item: JobsEnrichInput['jobs'][number], job: Job | undefined, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState, evidence: JobEvidence[]): Promise<JobsEnrichOutput['results'][number]> {
  if (!job) return failed(item.jobId, 'job_not_visible', 'Job is not available in the current tenant.')
  if (!job.url) return failed(item.jobId, 'job_url_missing', 'Job has no source URL.')
  if (!item.html && job.description) return enriched(item.jobId, job.description, null, 'stored', job.url, evidence)
  if (!item.html) return failed(item.jobId, 'html_required', 'HTML is required when the job has no stored description.')
  if (context.signal?.aborted) throw new DiscoveryToolError('cancelled', 'Enrichment was cancelled')
  usage.requests += 1
  const result = await (deps.enrich ?? enrichJob)({ html: item.html, url: job.url, userId: context.scope.userId })
  if (!result) return failed(item.jobId, 'enrichment_miss', 'No enrichment tier produced a description.')
  usage.providers.add(result.method)
  return enriched(item.jobId, result.description, result.applyUrl ?? null, result.method, job.url, evidence)
}

function enriched(jobId: string, description: string, applyUrl: string | null, method: string, url: string, evidence: JobEvidence[]): JobsEnrichOutput['results'][number] {
  const evidenceId = `evidence_${jobId}_${method}`
  evidence.push({ evidenceId, jobId, kind: 'enrichment', source: method, url, summary: `Enrichment tier ${method} produced the full job description.` })
  return { jobId, status: 'enriched', fullDescription: description, applyUrl, method, evidenceRefs: [evidenceId] }
}

export async function executeScore(input: JobsScoreInput, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState): Promise<Omit<JobsScoreOutput, 'usage'>> {
  const rows = await loadJobs(input.jobIds, context, deps)
  const evidence: JobEvidence[] = []
  const settled = await Promise.allSettled(input.jobIds.map(jobId => scoreOne(jobId, rows.get(jobId), context, deps, usage, evidence)))
  const results = settled.map((result, index) => result.status === 'fulfilled' ? result.value : failed(input.jobIds[index]!, 'score_failed', safeMessage(result.reason)))
  usage.jobsProcessed = input.jobIds.length
  usage.jobsSucceeded = results.filter(result => result.status === 'scored').length
  usage.jobsFailed = input.jobIds.length - usage.jobsSucceeded
  return { results, evidence }
}

async function scoreOne(jobId: string, job: Job | undefined, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState, evidence: JobEvidence[]): Promise<JobsScoreOutput['results'][number]> {
  if (!job) return failed(jobId, 'job_not_visible', 'Job is not available in the current tenant.')
  const pipeline = context.pipelineContext
  if (!pipeline) return failed(jobId, 'score_context_missing', 'Scoring requires the candidate resume and model context.')
  if (pipeline.userId && pipeline.userId !== context.scope.userId) throw new DiscoveryToolError('tenant_scope_mismatch', 'Scoring context belongs to another tenant.')
  if (context.signal?.aborted) throw new DiscoveryToolError('cancelled', 'Scoring was cancelled')
  usage.aiCalls += 1
  usage.providers.add(pipeline.aiConfig.provider)
  const stageContext: PipelineCtx = { ...pipeline, userId: context.scope.userId, sessionId: context.scope.sessionId }
  const result: StageResult<AnalyzeOutput> = await (deps.analyze ?? runAnalyze)([job], stageContext)
  const scored = result.data?.scoredJobs[0]
  if (!result.ok || !scored) return failed(jobId, 'score_failed', result.error ?? 'Job could not be scored.')
  const evidenceId = `evidence_${jobId}_analysis`
  evidence.push({ evidenceId, jobId, kind: 'analysis', source: pipeline.aiConfig.provider, url: job.url ?? `job:${jobId}`, summary: `Analyst score ${scored.score}/100 with matched and missing keyword evidence.` })
  return { jobId, status: 'scored', score: scored.score, matchedKeywords: scored.matchedKeywords, missingKeywords: scored.missingKeywords, recommendation: scored.recommendation, evidenceRefs: [evidenceId] }
}

export async function executeCompare(input: JobsCompareInput, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState): Promise<Omit<JobsCompareOutput, 'usage'>> {
  const rows = await loadJobs(input.jobIds, context, deps)
  const evidence: JobEvidence[] = []
  const comparisons: JobsCompareOutput['comparisons'] = []
  const failures: JobsCompareOutput['failures'] = []
  for (const jobId of input.jobIds) {
    const job = rows.get(jobId)
    if (!job) { failures.push(failed(jobId, 'job_not_visible', 'Job is not available in the current tenant.')); continue }
    const evidenceId = `evidence_${jobId}_comparison`
    evidence.push({ evidenceId, jobId, kind: 'comparison', source: 'deterministic', url: job.url ?? `job:${jobId}`, summary: 'Comparison features were read from the tenant-scoped Job record.' })
    const description = job.description ?? ''
    comparisons.push({ jobId, features: { title: job.role, company: job.company, location: job.location ?? '', source: job.source ?? 'unknown', url: job.url ?? '', salary: job.salary, score: job.score, hasFullDescription: description.trim().length > 0, descriptionLength: description.length }, evidenceRefs: [evidenceId] })
  }
  usage.jobsProcessed = input.jobIds.length
  usage.jobsSucceeded = comparisons.length
  usage.jobsFailed = failures.length
  return { comparisons, failures, evidence }
}

async function loadJobs(ids: readonly string[], context: DiscoveryToolContext, deps: DiscoveryToolDependencies): Promise<Map<string, Job>> {
  const rows = await database(deps).job.findMany({ where: { userId: context.scope.userId, id: { in: [...ids] } } })
  return new Map(rows.map(job => [job.id, job]))
}

function failed(jobId: string, code: string, message: string): { jobId: string; status: 'failed'; code: string; message: string } {
  return { jobId, status: 'failed', code, message: message.slice(0, 500) }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected job tool failure'
}
