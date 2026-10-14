import { createHash } from 'node:crypto'
import { Prisma, type Job } from '@prisma/client'

import { db } from '@/lib/db'
import { configureTenantTransaction } from '@/lib/db/tenant-store'
import { DiscoveryToolError } from './discovery-tool-support'
import type { DiscoveredJob } from './discover'

export type DiscoveryJobMaterializerFence = Readonly<{ userId: string; sessionId: string; turnId: string; stepId: string; taskId: string; rootTaskId: string; leaseOwner: string; attemptCount: number }>

type JobIdentity = Pick<Job, 'id' | 'url' | 'source'>
type JobIdentityDelegate = {
  findMany(args: { where: { userId: string; url?: string }; select: { id: true; url: true; source: true } }): Promise<JobIdentity[]>
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
}
type MaterializerTransaction = {
  job: JobIdentityDelegate
  $queryRaw<T>(query: Prisma.Sql): Promise<T>
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<number>
  $executeRawUnsafe?(query: string): Promise<number>
}
export type DiscoveryJobMaterializerDatabase = MaterializerTransaction & {
  $transaction<T>(callback: (transaction: MaterializerTransaction) => Promise<T>): Promise<T>
}
export type DiscoveryJobMaterializerDependencies = { db?: DiscoveryJobMaterializerDatabase }
const defaultDb = db as unknown as DiscoveryJobMaterializerDatabase

export function normalizeDiscoveryJobUrl(value: unknown, source?: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const provider = typeof source === 'string' ? source.toLowerCase() : ''
    const host = url.hostname.toLowerCase()
    if (provider === 'linkedin' || host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      const id = url.searchParams.get('currentJobId') ||
        url.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i)?.[1]
      if (id) return `${url.origin}/jobs/view/${id}/`
    }
    if (provider === 'indeed' || host === 'indeed.com' || host.endsWith('.indeed.com')) {
      const id = url.searchParams.get('jk') || url.searchParams.get('vjk')
      if (id) return `${url.origin}/viewjob?jk=${encodeURIComponent(id)}`
    }
    url.hash = ''
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !isLegacyTrackingKey(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        compareText(leftKey, rightKey) || compareText(leftValue, rightValue))
    url.search = ''
    for (const [key, entryValue] of query) url.searchParams.append(key, entryValue)
    return url.href
  } catch {
    return null
  }
}

function isLegacyTrackingKey(key: string): boolean {
  return /^(utm_|trk|ref|source|campaign)/i.test(key)
}

export function deterministicDiscoveryJobId(userId: string, normalizedUrl: string): string {
  return `c${createHash('sha256').update(`${userId}\u001f${normalizedUrl}`).digest('hex').slice(0, 24)}`
}

export async function materializeDiscoveredJobs(
  userId: string, candidates: readonly DiscoveredJob[], signal?: AbortSignal,
  fence?: DiscoveryJobMaterializerFence, deps: DiscoveryJobMaterializerDependencies = {},
): Promise<string[]> {
  if (!userId.trim()) throw new DiscoveryToolError('tenant_scope_required', 'A tenant is required to save discovered jobs')
  assertFence(userId, fence)
  const jobs = candidates.map(candidate => {
    const url = normalizeDiscoveryJobUrl(candidate.url, candidate.source)
    if (!url) throw new DiscoveryToolError('invalid_job_url', 'A discovered job must use a credential-free HTTP(S) URL')
    return { ...candidate, url }
  })
  const database = deps.db ?? defaultDb

  for (let attempt = 0; attempt <= jobs.length; attempt += 1) {
    try {
      return await database.$transaction(async transaction => {
        assertNotCancelled(signal)
        await lockAndValidateAttempt(transaction, fence)
        const ownerRows = await transaction.job.findMany({
          where: { userId }, select: { id: true, url: true, source: true },
        })
        const ids: string[] = []
        for (const candidate of jobs) {
          const existing = matchingOwnerRows(ownerRows, candidate.url, candidate.source)[0]
          if (existing) {
            ids.push(existing.id)
            continue
          }
          try {
            const created = await transaction.job.create({ data: jobData(userId, candidate) })
            ownerRows.push({ id: created.id, url: candidate.url, source: candidate.source })
            ids.push(created.id)
          } catch (error) {
            if (isUniqueConstraintConflict(error)) throw new IdentityRace(candidate.url)
            throw error
          }
        }
        assertNotCancelled(signal)
        await assertLiveAttempt(transaction, fence)
        assertNotCancelled(signal)
        return ids
      })
    } catch (error) {
      if (!(error instanceof IdentityRace)) throw error
      const racedRows = await database.job.findMany({
        where: { userId, url: error.url }, select: { id: true, url: true, source: true },
      })
      if (!matchingOwnerRows(racedRows, error.url, jobs.find(job => job.url === error.url)?.source ?? '')[0]) {
        throw new DiscoveryToolError('job_id_conflict', 'A discovered job ID conflicts with another saved row')
      }
      if (attempt === jobs.length) throw new DiscoveryToolError('job_id_conflict', 'A discovered job could not be saved after a concurrent create')
    }
  }
  throw new DiscoveryToolError('materialization_failed', 'Discovered jobs could not be saved')
}

function assertFence(userId: string, fence: DiscoveryJobMaterializerFence | undefined): asserts fence is DiscoveryJobMaterializerFence {
  if (!fence || fence.userId !== userId ||
      [fence.sessionId, fence.turnId, fence.stepId, fence.taskId, fence.rootTaskId, fence.leaseOwner].some(value => typeof value !== 'string' || !value.trim()) ||
      !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1) {
    throw new DiscoveryToolError('agent_scope_mismatch', 'The discovery execution attempt could not be verified')
  }
}

type MaterializerFenceTransaction = MaterializerTransaction
type ActiveTaskRow = { id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null; role: string; taskType: string; status: string; interruptRequestedAt: Date | string | null; closedAt: Date | string | null; leaseOwner: string | null; attemptCount: number; allowedActions: unknown }

async function lockAndValidateAttempt(tx: MaterializerFenceTransaction, fence: DiscoveryJobMaterializerFence): Promise<void> {
  await configureTenantTransaction(tx as never, fence.userId)
  const session = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_sessions"
    WHERE "id" = ${fence.sessionId} AND "userId" = ${fence.userId}
      AND "status" = 'running'
    FOR UPDATE
  `)
  if (!session[0]) throw scopeMismatch()

  const turn = await tx.$queryRaw<Array<{ id: string; rootTaskId: string | null; status: string }>>(Prisma.sql`
    SELECT "id", "rootTaskId", "status" FROM "agent_turns"
    WHERE "id" = ${fence.turnId} AND "sessionId" = ${fence.sessionId} AND "userId" = ${fence.userId}
      AND "rootTaskId" = ${fence.rootTaskId} AND "status" = 'in_progress'
    FOR UPDATE
  `)
  if (!turn[0]) throw scopeMismatch()

  const root = await tx.$queryRaw<Array<ActiveTaskRow>>(Prisma.sql`
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "role", "taskType", "status",
      "interruptRequestedAt", "closedAt", "leaseOwner", "attemptCount", "allowedActions"
    FROM "sub_agent_tasks"
    WHERE "id" = ${fence.rootTaskId} AND "sessionId" = ${fence.sessionId} AND "turnId" = ${fence.turnId}
      AND "rootTaskId" = ${fence.rootTaskId} AND "parentTaskId" IS NULL
      AND "role" = 'orchestrator' AND "taskType" = 'root' AND "status" = 'running'
      AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
    FOR UPDATE
  `)
  if (!root[0]) throw scopeMismatch()

  // Claim and interrupt flows take Session → Turn → root first. Lock this
  // streaming step before the exact child so the fence follows one order.
  const step = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_steps"
    WHERE "id" = ${fence.stepId} AND "sessionId" = ${fence.sessionId} AND "turnId" = ${fence.turnId}
      AND "taskId" = ${fence.taskId} AND "attempt" = ${fence.attemptCount} AND "status" = 'streaming'
    FOR UPDATE
  `)
  if (!step[0]) throw scopeMismatch()

  const child = await tx.$queryRaw<Array<ActiveTaskRow>>(Prisma.sql`
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "role", "taskType", "status",
      "interruptRequestedAt", "closedAt", "leaseOwner", "attemptCount", "allowedActions"
    FROM "sub_agent_tasks"
    WHERE "id" = ${fence.taskId} AND "sessionId" = ${fence.sessionId} AND "turnId" = ${fence.turnId}
      AND "rootTaskId" = ${fence.rootTaskId} AND "parentTaskId" = ${fence.rootTaskId}
      AND "role" = 'scout' AND "taskType" = 'job_discovery' AND "status" = 'running'
      AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
      AND "leaseOwner" = ${fence.leaseOwner} AND "attemptCount" = ${fence.attemptCount}
    FOR UPDATE
  `)
  if (!child[0] || !hasAction(child[0].allowedActions, 'jobs.discover')) throw scopeMismatch()

  await assertLiveAttempt(tx, fence)
}

async function assertLiveAttempt(tx: MaterializerFenceTransaction, fence: DiscoveryJobMaterializerFence): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string; interruptRequestedAt: Date | string | null; closedAt: Date | string | null; leaseOwner: string | null; attemptCount: number; live: boolean }>>(Prisma.sql`
    SELECT task."status", task."interruptRequestedAt", task."closedAt", task."leaseOwner", task."attemptCount",
      task."leaseExpiresAt" > clock_timestamp() AS "live"
    FROM "sub_agent_tasks" AS task
    WHERE task."id" = ${fence.taskId} AND task."sessionId" = ${fence.sessionId}
      AND task."turnId" = ${fence.turnId} AND task."rootTaskId" = ${fence.rootTaskId}
      AND task."parentTaskId" = ${fence.rootTaskId} AND task."role" = 'scout'
      AND task."taskType" = 'job_discovery' AND task."leaseOwner" = ${fence.leaseOwner}
      AND task."attemptCount" = ${fence.attemptCount}
  `)
  const task = rows[0]
  if (!task || task.status !== 'running' || task.interruptRequestedAt !== null || task.closedAt !== null || !task.live) {
    throw scopeMismatch()
  }
}

function hasAction(value: unknown, expected: string): boolean {
  let actions = value
  if (typeof actions === 'string') {
    try { actions = JSON.parse(actions) as unknown } catch { return false }
  }
  return Array.isArray(actions) && actions.includes(expected)
}

function scopeMismatch(): DiscoveryToolError {
  return new DiscoveryToolError('agent_scope_mismatch', 'The discovery execution attempt is no longer active')
}

function matchingOwnerRows(rows: readonly JobIdentity[], url: string, source: string): JobIdentity[] {
  return rows.filter(row => normalizeDiscoveryJobUrl(row.url, row.source) === url ||
      normalizeDiscoveryJobUrl(row.url, source) === url)
    .sort((left, right) => compareText(left.id, right.id))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function jobData(userId: string, candidate: DiscoveredJob): Record<string, unknown> {
  const company = candidate.company.trim()
  return {
    id: deterministicDiscoveryJobId(userId, candidate.url), userId, company,
    role: candidate.title.trim(), location: candidate.location.trim() || null,
    url: candidate.url, description: candidate.description || null,
    salary: candidate.salary, source: candidate.source,
    logo: candidate.logo ?? company.slice(0, 2).toUpperCase(),
    status: 'saved', workflowState: 'draft',
  }
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DiscoveryToolError('cancelled', 'Discovery was cancelled before saved jobs were committed')
}

function isUniqueConstraintConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

class IdentityRace extends Error {
  constructor(readonly url: string) { super('deterministic_job_id_race') }
}
