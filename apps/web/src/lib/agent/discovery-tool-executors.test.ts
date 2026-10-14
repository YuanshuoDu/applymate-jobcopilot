import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { materializeDiscoveredJobs, type DiscoveryJobMaterializerDatabase } from './discovery-job-materializer'
import { executeDiscover, type DiscoveryToolDependencies } from './discovery-tool-executors'
import type { DiscoveredJob, DiscoverParams } from './discover'
import type { DiscoveryToolContext, ToolUsageState } from './discovery-tool-support'
import type { JobsSearchInput } from './discovery-tool-types'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { job: { findMany: mocks.findMany } } }))

type FixtureJobDelegate = {
  findMany(args: { where: { userId: string; url?: string } }): Promise<Array<{ id: string; url: string; source: string }>>
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
}
type FixtureTransaction = {
  job: FixtureJobDelegate
  $queryRaw<T>(query: { sql: string }): Promise<T>
  $executeRaw: (...args: unknown[]) => Promise<number>
  $executeRawUnsafe: (query: string) => Promise<number>
}

const scope = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1', role: 'scout' as const }
const context: DiscoveryToolContext = { scope }
const executionFence = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1',
  taskId: 'scout-1', rootTaskId: 'root-1', leaseOwner: 'worker-1', attemptCount: 4,
}
const input: JobsSearchInput = { targetRoles: ['Engineer'], targetLocations: ['Dublin'], pageSize: 2 }

function candidate(id: number, url = `https://jobs.example/role/${id}`): DiscoveredJob {
  return { title: `Engineer ${id}`, company: 'Acme', location: 'Dublin', url, description: `Description ${id}`, salary: null, logo: null, source: 'greenhouse' }
}

function usage(): ToolUsageState {
  return { requests: 0, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: new Set(), estimatedCostUsd: 0 }
}

function materializerFixture() {
  const rows = new Map<string, { id: string; userId: string; url: string; source: string }>()
  const db = {
    job: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; url?: string } }) => [...rows.values()]
        .filter(row => row.userId === where.userId && (where.url === undefined || row.url === where.url))
        .map(({ id, url, source }) => ({ id, url, source }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = String(data.id)
        if (rows.has(id)) throw { code: 'P2002' }
        rows.set(id, { id, userId: String(data.userId), url: String(data.url), source: String(data.source) })
        return { id }
      }),
    },
    async $transaction<T>(callback: (transaction: FixtureTransaction) => Promise<T>): Promise<T> {
      const staged = new Map(rows)
      const result = await callback({ job: {
        findMany: async ({ where }: { where: { userId: string; url?: string } }) => [...staged.values()]
          .filter(row => row.userId === where.userId && (where.url === undefined || row.url === where.url))
          .map(({ id, url, source }) => ({ id, url, source })),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const id = String(data.id)
          if (staged.has(id)) throw { code: 'P2002' }
          staged.set(id, { id, userId: String(data.userId), url: String(data.url), source: String(data.source) })
          return { id }
        },
      },
        $executeRaw: async () => 1,
        $executeRawUnsafe: async () => 1,
        $queryRaw: async <T>(query: { sql: string }): Promise<T> => {
          const sql = query.sql
          if (sql.includes('FROM "agent_sessions"')) return [{ id: executionFence.sessionId, status: 'running' }] as T
          if (sql.includes('FROM "agent_turns"')) return [{ id: executionFence.turnId, rootTaskId: executionFence.rootTaskId, status: 'in_progress' }] as T
          if (sql.includes('FROM "agent_steps"')) return [{ id: executionFence.stepId }] as T
          if (sql.includes('clock_timestamp()')) return [{ status: 'running', interruptRequestedAt: null, closedAt: null,
            leaseOwner: executionFence.leaseOwner, attemptCount: executionFence.attemptCount, live: true }] as T
          if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("'scout'")) return [{ id: executionFence.taskId,
            sessionId: executionFence.sessionId, turnId: executionFence.turnId, rootTaskId: executionFence.rootTaskId,
            parentTaskId: executionFence.rootTaskId, role: 'scout', taskType: 'job_discovery', status: 'running',
            interruptRequestedAt: null, closedAt: null, leaseOwner: executionFence.leaseOwner,
            attemptCount: executionFence.attemptCount, allowedActions: ['jobs.discover'] }] as T
          if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: executionFence.rootTaskId,
            sessionId: executionFence.sessionId, turnId: executionFence.turnId, rootTaskId: executionFence.rootTaskId,
            parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'running',
            interruptRequestedAt: null, closedAt: null, leaseOwner: null, attemptCount: 1, allowedActions: [] }] as T
          throw new Error(`Unexpected materializer SQL: ${sql}`)
        },
      })
      rows.clear()
      for (const [id, row] of staged) rows.set(id, row)
      return result
    },
  } as unknown as DiscoveryJobMaterializerDatabase
  return { db, rows }
}

describe('executeDiscover', () => {
  beforeEach(() => {
    mocks.findMany.mockReset()
    vi.stubEnv('AGENT_WORKER_SECRET', 'test-secret')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('keeps provider pages stable when owner Jobs are materialized between calls and reuses canonical IDs on replay', async () => {
    const store = materializerFixture()
    const providerCandidates = [
      candidate(1, 'https://jobs.example/role/1?utm_source=mail'),
      candidate(101, 'https://jobs.example/role/1'),
      candidate(2), candidate(3), candidate(4),
    ]
    const discover = vi.fn(async (params: DiscoverParams) => {
      expect(params.existingUrls.size).toBe(0)
      expect(params.maxResults).toBe(100)
      params.onProviderCall?.({ provider: 'greenhouse', role: 'Engineer', location: 'Dublin', jobsReturned: 5, status: 'success', latencyMs: 12 })
      return providerCandidates
    })
    const dependencies: DiscoveryToolDependencies = {
      discover,
      executionFence,
      materialize: (userId, jobs, signal, fence) => materializeDiscoveredJobs(userId, jobs, signal, fence, { db: store.db }),
    }

    const firstUsage = usage()
    const first = await executeDiscover(input, context, dependencies, firstUsage)
    const secondUsage = usage()
    const second = await executeDiscover({ ...input, cursor: first.nextCursor! }, context, dependencies, secondUsage)
    const replayUsage = usage()
    const replay = await executeDiscover(input, context, dependencies, replayUsage)

    expect(first.jobs.map(job => job.url)).toEqual(['https://jobs.example/role/1', 'https://jobs.example/role/2'])
    expect(second.jobs.map(job => job.url)).toEqual(['https://jobs.example/role/3', 'https://jobs.example/role/4'])
    expect(replay.jobs.map(job => job.id)).toEqual(first.jobs.map(job => job.id))
    expect(first.jobs[0]?.id).toMatch(/^c[a-z0-9]{24}$/)
    expect(first.evidence.every(item => item.jobId.startsWith('c'))).toBe(true)
    expect(firstUsage).toMatchObject({ requests: 1, jobsProcessed: 2, jobsSucceeded: 2, jobsFailed: 0 })
    expect(secondUsage).toMatchObject({ requests: 1, jobsProcessed: 2, jobsSucceeded: 2, jobsFailed: 0 })
    expect(store.rows.size).toBe(4)
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('builds and advances a source-scoped provider window before applying cursor offsets', async () => {
    const store = materializerFixture()
    const candidates = [
      { ...candidate(1), source: 'greenhouse' },
      { ...candidate(2), source: 'linkedin' },
      { ...candidate(3), source: 'linkedin' },
      { ...candidate(4), source: 'adzuna' },
    ]
    const discover = vi.fn(async (params: DiscoverParams) => {
      expect(params.existingUrls.size).toBe(0)
      return candidates.filter(job => !params.source || job.source.toLowerCase() === params.source.toLowerCase())
    })
    const dependencies: DiscoveryToolDependencies = {
      discover, executionFence,
      materialize: (userId, jobs, signal, fence) => materializeDiscoveredJobs(userId, jobs, signal, fence, { db: store.db }),
    }

    const first = await executeDiscover({ ...input, source: 'LinkedIn', pageSize: 1 }, context, dependencies, usage())
    const second = await executeDiscover({ ...input, source: 'LinkedIn', pageSize: 1, cursor: first.nextCursor! }, context, dependencies, usage())

    expect(first.jobs.map(job => job.url)).toEqual(['https://jobs.example/role/2'])
    expect(second.jobs.map(job => job.url)).toEqual(['https://jobs.example/role/3'])
    expect(first.nextCursor).toBeTruthy()
    expect(second.nextCursor).toBeNull()
    expect(discover.mock.calls.map(([params]) => params.source)).toEqual(['LinkedIn', 'LinkedIn'])
  })

  it('splits oversized aggregate pages without dropping candidates or duplicating pages', async () => {
    const store = materializerFixture()
    const providerCandidates = Array.from({ length: 10 }, (_, index) => ({
      ...candidate(index + 1), description: 'd'.repeat(100_000),
    }))
    const discover = vi.fn(async () => providerCandidates)
    const dependencies: DiscoveryToolDependencies = {
      discover,
      executionFence,
      materialize: (userId, jobs, signal, fence) => materializeDiscoveredJobs(userId, jobs, signal, fence, { db: store.db }),
    }

    const pages: Array<Awaited<ReturnType<typeof executeDiscover>>> = []
    let cursor: string | undefined
    do {
      const page = await executeDiscover({ ...input, pageSize: 10, ...(cursor ? { cursor } : {}) }, context, dependencies, usage())
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    const returnedJobs = pages.flatMap(page => page.jobs)
    const returnedUrls = returnedJobs.map(job => job.url)
    expect(pages.length).toBeGreaterThan(1)
    expect(Math.max(...pages.map(page => page.jobs.length))).toBeLessThan(10)
    expect(returnedUrls).toEqual(providerCandidates.map(job => job.url))
    expect(new Set(returnedUrls).size).toBe(providerCandidates.length)
    expect(returnedJobs.every(job => job.description.length === 7_000 && job.fullDescription.length === 7_000)).toBe(true)
    expect(pages[pages.length - 1]?.nextCursor).toBeNull()
    expect(store.rows.size).toBe(providerCandidates.length)
  })

  it('keeps provider-call and materialization failures separate in usage', async () => {
    const discover = vi.fn(async (params: DiscoverParams) => {
      await params.onProviderCall?.({ provider: 'adzuna', role: 'Engineer', location: 'Dublin', jobsReturned: 1, status: 'success', latencyMs: 4 })
      await params.onProviderCall?.({ provider: 'greenhouse', role: 'Engineer', location: 'Dublin', jobsReturned: 0, status: 'error', latencyMs: 7 })
      return [candidate(1)]
    })
    const failedUsage = usage()
    await expect(executeDiscover(input, context, { discover, executionFence, materialize: async () => { throw new Error('DB unavailable') } }, failedUsage))
      .rejects.toThrow('DB unavailable')
    expect(failedUsage).toMatchObject({ requests: 2, jobsProcessed: 1, jobsSucceeded: 0, jobsFailed: 1, providerFailures: 1 })

    const providerFailureDiscover = vi.fn(async (params: DiscoverParams) => {
      await params.onProviderCall?.({ provider: 'adzuna', role: 'Engineer', location: 'Dublin', jobsReturned: 0, status: 'error', latencyMs: 4 })
      return []
    })
    const providerFailureUsage = usage()
    const providerFailure = await executeDiscover(input, context, { discover: providerFailureDiscover, executionFence, materialize: async () => [] }, providerFailureUsage)
    expect(providerFailure.jobs).toEqual([])
    expect(providerFailureUsage).toMatchObject({ requests: 1, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 1 })
    expect(providerFailureUsage.providers).toEqual(new Set(['adzuna']))
  })

  it('keeps provider failure counts when another provider returns materialized jobs', async () => {
    const discover = vi.fn(async (params: DiscoverParams) => {
      await params.onProviderCall?.({ provider: 'adzuna', role: 'Engineer', location: 'Dublin', jobsReturned: 0, status: 'error', latencyMs: 4 })
      await params.onProviderCall?.({ provider: 'greenhouse', role: 'Engineer', location: 'Dublin', jobsReturned: 1, status: 'success', latencyMs: 8 })
      return [candidate(1)]
    })
    const partialUsage = usage()
    const result = await executeDiscover(input, context, {
      discover, executionFence,
      materialize: async (_userId, jobs) => jobs.map((_, index) => 'canonical-' + index),
    }, partialUsage)

    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]?.id).toBe('canonical-0')
    expect(result.evidence[0]?.jobId).toBe('canonical-0')
    expect(partialUsage).toMatchObject({ requests: 2, jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 1 })
    expect(partialUsage.providers).toEqual(new Set(['adzuna', 'greenhouse']))
  })

  it('skips malformed injected discovery items without failing valid partial results', async () => {
    const malformed = [
      { ...candidate(2), title: undefined },
      { ...candidate(3), company: undefined },
      { ...candidate(4), source: undefined },
    ] as unknown as DiscoveredJob[]
    const discover = vi.fn(async (params: DiscoverParams) => {
      await params.onProviderCall?.({ provider: 'linkedin', role: 'Engineer', location: 'Dublin', jobsReturned: 4, status: 'error', latencyMs: 4 })
      return [{ ...candidate(1), source: 'linkedin' }, ...malformed]
    })
    const partialUsage = usage()
    const result = await executeDiscover({ ...input, source: 'linkedin' }, context, {
      discover, executionFence, materialize: async (_userId, jobs) => jobs.map(() => 'canonical-1'),
    }, partialUsage)

    expect(result.jobs.map(job => job.title)).toEqual(['Engineer 1'])
    expect(result.jobs[0]?.id).toBe('canonical-1')
    expect(result.evidence[0]?.jobId).toBe('canonical-1')
    expect(partialUsage).toMatchObject({ requests: 1, jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 1 })
  })

  it('bounds persisted provider fields and drops URLs that exceed the output limit', async () => {
    const oversized = {
      ...candidate(1),
      title: 't'.repeat(600), company: 'c'.repeat(600), location: 'l'.repeat(600),
      description: 'd'.repeat(120_000), salary: 's'.repeat(700), logo: 'i'.repeat(5_000), source: 'g'.repeat(100),
    }
    const discover = vi.fn(async () => [
      candidate(2, `https://jobs.example/${'x'.repeat(5_000)}`), oversized,
    ])
    const materialized: DiscoveredJob[][] = []
    const result = await executeDiscover(input, context, {
      discover, executionFence,
      materialize: async (_userId, jobs) => {
        materialized.push([...jobs])
        return jobs.map(() => 'canonical-1')
      },
    }, usage())

    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({
      id: 'canonical-1', title: 't'.repeat(500), company: 'c'.repeat(500), location: 'l'.repeat(500),
      description: 'd'.repeat(7_000), fullDescription: 'd'.repeat(7_000), salary: 's'.repeat(500),
      logo: 'i'.repeat(4_096), source: 'g'.repeat(80),
    })
    expect(materialized[0]?.[0]?.description).toBe('d'.repeat(100_000))
    expect(result.jobs[0]?.url.length).toBeLessThanOrEqual(4_096)
    expect(result.evidence[0]?.summary.length).toBeLessThanOrEqual(1_000)
  })

  it('honors cancellation after provider work and before persistence', async () => {
    const controller = new AbortController()
    const materialize = vi.fn(async () => [])
    const discover = vi.fn(async () => { controller.abort(); return [candidate(1)] })
    const cancelledContext = { ...context, signal: controller.signal }
    const cancelledUsage = usage()

    await expect(executeDiscover(input, cancelledContext, { discover, materialize, executionFence }, cancelledUsage))
      .rejects.toMatchObject({ code: 'cancelled' })
    expect(materialize).not.toHaveBeenCalled()
    expect(cancelledUsage.jobsFailed).toBe(0)
  })
})
