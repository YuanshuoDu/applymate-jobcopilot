import { describe, expect, it, vi } from 'vitest'

import {
  deterministicDiscoveryJobId,
  materializeDiscoveredJobs,
  normalizeDiscoveryJobUrl,
  type DiscoveryJobMaterializerDatabase,
} from './discovery-job-materializer'
import type { DiscoveredJob } from './discover'

type StoredJob = { id: string; userId: string; url: string | null; source: string | null }
const fence = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1',
  taskId: 'scout-1', rootTaskId: 'root-1', leaseOwner: 'worker-1', attemptCount: 4,
}

function candidate(url = 'https://jobs.example/role/1?utm_source=mail'): DiscoveredJob {
  return { title: 'Engineer', company: 'Acme', location: 'Dublin', url, description: 'Full description', salary: null, logo: null, source: 'greenhouse' }
}

function fixture(initial: StoredJob[] = [], options: {
  raceOnCreate?: boolean; afterCreate?: () => void; scope?: Partial<{
    sessionStatus: string; turnStatus: string; turnRootTaskId: string; rootStatus: string; rootInterrupted: Date | null
    childStatus: string; childInterrupted: Date | null; childClosed: Date | null; childLeaseOwner: string
    childAttemptCount: number; childLive: boolean; childActions: unknown; stepAttempt: number; stepStatus: string
  }>
} = {}) {
  const rows = new Map(initial.map(row => [row.id, row]))
  const createData: Record<string, unknown>[] = []
  const whereQueries: Array<{ userId: string; url?: string }> = []
  const queryLog: string[] = []
  const scope = {
    sessionStatus: 'running', turnStatus: 'in_progress', turnRootTaskId: fence.rootTaskId,
    rootStatus: 'running', rootInterrupted: null as Date | null,
    childStatus: 'running', childInterrupted: null as Date | null, childClosed: null as Date | null,
    childLeaseOwner: fence.leaseOwner, childAttemptCount: fence.attemptCount, childLive: true,
    childActions: ['jobs.discover'], stepAttempt: fence.attemptCount, stepStatus: 'streaming',
    ...options.scope,
  }
  let raced = false

  const delegate = (view: Map<string, StoredJob>, transactional: boolean) => ({
    findMany: vi.fn(async ({ where }: { where: { userId: string; url?: string } }) => {
      whereQueries.push(where)
      return [...view.values()]
        .filter(row => row.userId === where.userId && (where.url === undefined || row.url === where.url))
        .map(({ id, url, source }) => ({ id, url, source }))
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      createData.push(data)
      const id = String(data.id)
      if (options.raceOnCreate && transactional && !raced) {
        raced = true
        rows.set(id, { id, userId: String(data.userId), url: String(data.url), source: String(data.source) })
        throw { code: 'P2002' }
      }
      if (view.has(id)) throw { code: 'P2002' }
      view.set(id, { id, userId: String(data.userId), url: String(data.url), source: String(data.source) })
      options.afterCreate?.()
      return { id }
    }),
  })

  const database = {
    job: delegate(rows, false),
    async $transaction<T>(callback: (transaction: Record<string, unknown>) => Promise<T>): Promise<T> {
      const staged = new Map(rows)
      const transaction = {
        job: delegate(staged, true),
        $executeRaw: vi.fn(async () => 1),
        $executeRawUnsafe: vi.fn(async () => 1),
        $queryRaw: vi.fn(async (query: { sql: string }) => {
          const sql = query.sql
          queryLog.push(sql)
          if (sql.includes('FROM "agent_sessions"')) return [{ id: fence.sessionId, status: scope.sessionStatus }]
          if (sql.includes('FROM "agent_turns"')) return scope.turnStatus === 'in_progress' && scope.turnRootTaskId === fence.rootTaskId
            ? [{ id: fence.turnId, rootTaskId: scope.turnRootTaskId, status: scope.turnStatus }] : []
          if (sql.includes('FROM "agent_steps"')) return scope.stepStatus === 'streaming' && scope.stepAttempt === fence.attemptCount
            ? [{ id: fence.stepId }] : []
          if (sql.includes('clock_timestamp()')) return [{ status: scope.childStatus,
            interruptRequestedAt: scope.childInterrupted, closedAt: scope.childClosed,
            leaseOwner: scope.childLeaseOwner, attemptCount: scope.childAttemptCount, live: scope.childLive }]
          if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("'scout'")) {
            return scope.childLeaseOwner === fence.leaseOwner && scope.childAttemptCount === fence.attemptCount
              && scope.childStatus === 'running' && scope.childInterrupted === null && scope.childClosed === null
              ? [{ id: fence.taskId, sessionId: fence.sessionId, turnId: fence.turnId, rootTaskId: fence.rootTaskId,
                  parentTaskId: fence.rootTaskId, role: 'scout', taskType: 'job_discovery', status: scope.childStatus,
                  interruptRequestedAt: scope.childInterrupted, closedAt: scope.childClosed, leaseOwner: scope.childLeaseOwner,
                  attemptCount: scope.childAttemptCount, allowedActions: scope.childActions }]
              : []
          }
          if (sql.includes('FROM "sub_agent_tasks"')) return scope.rootStatus === 'running' && scope.rootInterrupted === null
            ? [{ id: fence.rootTaskId, sessionId: fence.sessionId, turnId: fence.turnId, rootTaskId: fence.rootTaskId,
                parentTaskId: null, role: 'orchestrator', taskType: 'root', status: scope.rootStatus,
                interruptRequestedAt: scope.rootInterrupted, closedAt: null, leaseOwner: null, attemptCount: 1,
                allowedActions: ['agent.plan'] }]
            : []
          throw new Error(`Unexpected materializer SQL: ${sql}`)
        }),
      }
      const result = await callback(transaction)
      rows.clear()
      for (const [id, row] of staged) rows.set(id, row)
      return result
    },
  } as unknown as DiscoveryJobMaterializerDatabase
  return { database, rows, createData, whereQueries, queryLog, scope }
}

describe('discovery job URL identity', () => {
  it('requires credential-free HTTP(S), removes tracking keys and fragments, and sorts remaining query values', () => {
    expect(normalizeDiscoveryJobUrl('https://jobs.example/Case?z=2&utm_source=x&a=1&campaignId=3#section'))
      .toBe('https://jobs.example/Case?a=1&z=2')
    expect(normalizeDiscoveryJobUrl('https://jobs.example/role?utm_medium=mail&TRK=feed&Ref=listing&Source=search&CampaignId=3&reference=drop&sourceType=drop&trkId=drop&keep=1&utm=keep'))
      .toBe('https://jobs.example/role?keep=1&utm=keep')
    expect(normalizeDiscoveryJobUrl('https://jobs.example/role?b=2&a=2&a=1'))
      .toBe('https://jobs.example/role?a=1&a=2&b=2')
    expect(normalizeDiscoveryJobUrl('https://jobs.example/case?a=1&z=2')).not.toBe('https://jobs.example/Case?a=1&z=2')
    expect(normalizeDiscoveryJobUrl('not a URL')).toBeNull()
    expect(normalizeDiscoveryJobUrl('http://[broken')).toBeNull()
    expect(normalizeDiscoveryJobUrl('ftp://jobs.example/role')).toBeNull()
    expect(normalizeDiscoveryJobUrl('https://user:pass@jobs.example/role')).toBeNull()
  })

  it('canonicalizes LinkedIn and Indeed vacancy IDs like the existing save route', () => {
    expect(normalizeDiscoveryJobUrl('https://www.linkedin.com/jobs/view/senior-engineer-1234567/?currentJobId=9999999', 'linkedin'))
      .toBe('https://www.linkedin.com/jobs/view/9999999/')
    expect(normalizeDiscoveryJobUrl('https://ie.indeed.com/viewjob?vjk=a%2Fb&utm_source=mail', 'indeed'))
      .toBe('https://ie.indeed.com/viewjob?jk=a%2Fb')
  })

  it('creates owner-specific CUID-compatible IDs and reuses the lowest matching legacy row', async () => {
    const url = 'https://www.linkedin.com/jobs/view/1234567/'
    const db = fixture([
      { id: 'z-legacy', userId: 'user-1', url: 'https://www.linkedin.com/jobs/view/senior-role-1234567?utm_campaign=old', source: 'linkedin' },
      { id: 'a-legacy', userId: 'user-1', url, source: 'linkedin' },
      { id: '0-foreign', userId: 'user-2', url, source: 'linkedin' },
    ])

    await expect(materializeDiscoveredJobs('user-1', [candidate('https://www.linkedin.com/jobs/view/senior-role-1234567/?trk=feed')], undefined, fence, { db: db.database }))
      .resolves.toEqual(['a-legacy'])
    expect(db.createData).toHaveLength(0)
    expect(deterministicDiscoveryJobId('user-1', url)).toMatch(/^c[a-z0-9]{24}$/)
    expect(deterministicDiscoveryJobId('user-1', url)).not.toBe(deterministicDiscoveryJobId('user-2', url))
  })

  it('creates a saved row once and recovers a deterministic primary-key race by owner and URL', async () => {
    const job = candidate()
    const normalizedUrl = normalizeDiscoveryJobUrl(job.url, job.source)!
    const db = fixture([], { raceOnCreate: true })

    const first = await materializeDiscoveredJobs('user-1', [job], undefined, fence, { db: db.database })
    const replay = await materializeDiscoveredJobs('user-1', [job], undefined, fence, { db: db.database })

    expect(first).toEqual([deterministicDiscoveryJobId('user-1', normalizedUrl)])
    expect(replay).toEqual(first)
    expect(db.rows.size).toBe(1)
    expect(db.createData[0]).toMatchObject({ userId: 'user-1', url: normalizedUrl, status: 'saved', workflowState: 'draft' })
    expect(db.whereQueries).toContainEqual({ userId: 'user-1', url: normalizedUrl })
  })

  it('fails closed on a foreign ID collision and rolls back when cancellation arrives before commit', async () => {
    const job = candidate()
    const url = normalizeDiscoveryJobUrl(job.url, job.source)!
    const id = deterministicDiscoveryJobId('user-1', url)
    const foreign = fixture([{ id, userId: 'user-2', url, source: job.source }])
    await expect(materializeDiscoveredJobs('user-1', [job], undefined, fence, { db: foreign.database }))
      .rejects.toMatchObject({ code: 'job_id_conflict' })
    expect(foreign.whereQueries.every(query => query.userId === 'user-1')).toBe(true)

    const controller = new AbortController()
    const cancelled = fixture([], { afterCreate: () => controller.abort() })
    await expect(materializeDiscoveredJobs('user-1', [job], controller.signal, fence, { db: cancelled.database }))
      .rejects.toMatchObject({ code: 'cancelled' })
    expect(cancelled.rows.size).toBe(0)
  })

  it('locks scope in claim order and evaluates lease expiry after locks and immediately before commit', async () => {
    const db = fixture()
    await materializeDiscoveredJobs('user-1', [candidate()], undefined, fence, { db: db.database })

    const lockTables = db.queryLog.filter(sql => sql.includes('FOR UPDATE')).map(sql =>
      sql.includes('FROM "agent_sessions"') ? 'session'
        : sql.includes('FROM "agent_turns"') ? 'turn'
          : sql.includes('FROM "agent_steps"') ? 'step'
            : sql.includes("'scout'") ? 'child' : 'root')
    expect(lockTables).toEqual(['session', 'turn', 'root', 'step', 'child'])
    const clockChecks = db.queryLog.map((sql, index) => sql.includes('clock_timestamp()') ? index : -1).filter(index => index >= 0)
    const stepLock = db.queryLog.findIndex(sql => sql.includes('FROM "agent_steps"') && sql.includes('FOR UPDATE'))
    expect(clockChecks).toHaveLength(2)
    expect(clockChecks[0]).toBeGreaterThan(stepLock)
    expect(clockChecks[1]).toBe(db.queryLog.length - 1)
  })

  it.each([
    ['replacement owner', { childLeaseOwner: 'worker-replacement' }],
    ['replacement attempt', { childAttemptCount: fence.attemptCount + 1 }],
    ['interrupted child', { childInterrupted: new Date() }],
    ['non-running child', { childStatus: 'retrying' }],
    ['non-streaming step', { stepStatus: 'completed' }],
    ['different step attempt', { stepAttempt: fence.attemptCount + 1 }],
    ['interrupted root', { rootInterrupted: new Date() }],
    ['different Turn state', { turnStatus: 'waiting_for_dependency' }],
  ])('does not write when the locked scope has %s', async (_label, scope) => {
    const db = fixture([], { scope })
    await expect(materializeDiscoveredJobs('user-1', [candidate()], undefined, fence, { db: db.database }))
      .rejects.toMatchObject({ code: 'agent_scope_mismatch' })
    expect(db.rows.size).toBe(0)
    expect(db.createData).toHaveLength(0)
  })

  it('rolls back candidate rows if the lease expires before the final commit fence', async () => {
    const db = fixture([], { afterCreate: () => { db.scope.childLive = false } })
    await expect(materializeDiscoveredJobs('user-1', [candidate()], undefined, fence, { db: db.database }))
      .rejects.toMatchObject({ code: 'agent_scope_mismatch' })
    expect(db.rows.size).toBe(0)
    expect(db.queryLog.at(-1)).toContain('clock_timestamp()')
  })
})
