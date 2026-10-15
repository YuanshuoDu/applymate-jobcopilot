import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveryToolContext, ToolUsageState } from '@/lib/agent/discovery-tool-support'
import type { DiscoveryToolDependencies } from '@/lib/agent/discovery-tool-executors'
import { JobsSearchInputSchema, type JobsSearchInput } from '@/lib/agent/discovery-tool-types'
import type { DiscoveryJobMaterializerDatabase } from '@/lib/agent/discovery-job-materializer'

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(), turnFindFirst: vi.fn(), stepFindFirst: vi.fn(), taskFindFirst: vi.fn(), executeDiscover: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst }, agentTurn: { findFirst: mocks.turnFindFirst },
  agentStep: { findFirst: mocks.stepFindFirst }, subAgentTask: { findFirst: mocks.taskFindFirst },
} }))
vi.mock('@/lib/agent/discovery-tool-executors', () => ({ executeDiscover: mocks.executeDiscover }))

const payload = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1',
  taskId: 'scout-1', rootTaskId: 'root-1', leaseOwner: 'worker-1', attemptCount: 4, role: 'scout',
  targetRoles: ['Engineer'], targetLocations: ['Dublin'], pageSize: 2,
}
const canonicalId = 'c123456789012345678901234'
type SearchTargetField = 'targetRoles' | 'targetLocations'

function schemaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function schemaTargetBound(field: SearchTargetField, bound: 'minItems' | 'maxItems' | 'maxLength'): number {
  const target = schemaRecord(schemaRecord(JobsSearchInputSchema.properties)?.[field])
  const value = bound === 'maxLength' ? schemaRecord(target?.items)?.maxLength : target?.[bound]
  const resolved = value === undefined && bound === 'minItems' ? 0 : value
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved)) throw new Error('Missing search target schema bound')
  return resolved
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1',
    targetRoles: ['Persisted role'], targetLocations: ['Persisted location'], minScore: 70,
    dailyCap: 10, requireApproval: true, autoApply: false, ...overrides,
  }
}
let activeChildAttempt = { leaseOwner: 'worker-1', attemptCount: 4, leaseExpiresAt: new Date(Date.now() + 60_000) }

function request(body: unknown, headers: Record<string, string> = { 'x-agent-worker-secret': 'secret' }) {
  return new Request('http://localhost/api/internal/agent-runtime/discovery/search', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as never
}

describe('internal provider discovery route', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv('AGENT_WORKER_SECRET', 'secret')
    activeChildAttempt = { leaseOwner: 'worker-1', attemptCount: 4, leaseExpiresAt: new Date(Date.now() + 60_000) }
    mocks.sessionFindFirst.mockResolvedValue({ id: 'session-1' })
    mocks.turnFindFirst.mockResolvedValue({
      id: 'turn-1', sessionId: 'session-1', userId: 'user-1', rootTaskId: 'root-1', source: 'user',
      input: { scheduledAutomationSnapshot: snapshot({ targetRoles: ['Must not override manual search'] }) },
    })
    mocks.stepFindFirst.mockResolvedValue({ id: 'step-1', attempt: 4 })
    mocks.taskFindFirst.mockImplementation(async ({ where }: { where: { id: string; leaseOwner?: string; attemptCount?: number; leaseExpiresAt?: { gt: Date } } }) => {
      if (where.id === 'root-1') return { id: 'root-1' }
      if (where.leaseOwner !== activeChildAttempt.leaseOwner || where.attemptCount !== activeChildAttempt.attemptCount ||
          !where.leaseExpiresAt || where.leaseExpiresAt.gt.getTime() >= activeChildAttempt.leaseExpiresAt.getTime()) return null
      return { id: 'scout-1', allowedActions: ['jobs.search', 'jobs.get', 'jobs.discover'], ...activeChildAttempt }
    })
    mocks.executeDiscover.mockImplementation(async (_input: JobsSearchInput, _context: DiscoveryToolContext, _deps: DiscoveryToolDependencies, usage: ToolUsageState) => {
      usage.requests = 1
      usage.jobsProcessed = 1
      usage.jobsSucceeded = 1
      usage.providers.add('greenhouse')
      return {
        jobs: [{ id: canonicalId, title: 'Engineer', company: 'Acme', location: 'Dublin', url: 'https://jobs.example/1', description: 'JD', fullDescription: 'JD', salary: null, logo: null, source: 'greenhouse', evidenceRefs: ['evidence_' + canonicalId + '_source'] }],
        evidence: [{ evidenceId: 'evidence_' + canonicalId + '_source', jobId: canonicalId, kind: 'source', source: 'greenhouse', url: 'https://jobs.example/1', summary: 'Provider result' }],
        nextCursor: null,
      }
    })
  })

  it('authenticates the Worker, validates live Scout scope, and preserves manual criteria', async () => {
    const { POST } = await import('./route')
    const response = await POST(request(payload))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.jobs[0].id).toBe(canonicalId)
    expect(result.evidence[0].jobId).toBe(canonicalId)
    expect(result.usage).toMatchObject({
      toolName: 'jobs.discover', toolCallId: 'call-1', requests: 1, jobsProcessed: 1,
      jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, providers: ['greenhouse'],
      durationMs: expect.any(Number),
    })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: 'session-1', userId: 'user-1', status: 'running' }, select: { id: true } })
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: 'turn-1', sessionId: 'session-1', userId: 'user-1', status: 'in_progress' },
      select: { id: true, sessionId: true, userId: true, rootTaskId: true, source: true, input: true },
    })
    expect(mocks.stepFindFirst).toHaveBeenCalledWith({ where: { id: 'step-1', sessionId: 'session-1', turnId: 'turn-1', taskId: 'scout-1', status: 'streaming' }, select: { id: true, attempt: true } })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith({ where: {
      id: 'root-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: null,
      role: 'orchestrator', taskType: 'root', status: 'running', interruptRequestedAt: null, closedAt: null,
    }, select: { id: true } })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: 'scout-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'scout', taskType: 'job_discovery', status: 'running', interruptRequestedAt: null, closedAt: null,
      leaseOwner: 'worker-1', attemptCount: 4, leaseExpiresAt: { gt: expect.any(Date) },
    }), select: { id: true, allowedActions: true, leaseOwner: true, attemptCount: true } }))
    expect(mocks.executeDiscover).toHaveBeenCalledWith({
      targetRoles: ['Engineer'], targetLocations: ['Dublin'], pageSize: 2,
    }, expect.objectContaining({
      scope: { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1', role: 'scout' },
    }), { executionFence: {
      userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1',
      taskId: 'scout-1', rootTaskId: 'root-1', leaseOwner: 'worker-1', attemptCount: 4,
    } }, expect.any(Object))
  })

  it('uses persisted automation criteria for paginated discovery and ignores model overrides', async () => {
    mocks.turnFindFirst.mockResolvedValue({
      id: 'turn-1', sessionId: 'session-1', userId: 'user-1', rootTaskId: 'root-1', source: 'automation',
      input: { scheduledAutomationSnapshot: snapshot({ targetRoles: ['Saved engineer'], targetLocations: ['Dublin'] }) },
    })
    const { POST } = await import('./route')
    const response = await POST(request({
      ...payload, targetRoles: ['Model manager'], targetLocations: ['Model city'], source: 'greenhouse',
      pageSize: 3, cursor: 'saved-cursor',
    }))

    expect(response.status).toBe(200)
    expect(mocks.executeDiscover).toHaveBeenCalledWith({
      targetRoles: ['Saved engineer'], targetLocations: ['Dublin'], source: 'greenhouse',
      pageSize: 3, cursor: 'saved-cursor',
    }, expect.any(Object), expect.any(Object), expect.any(Object))
  })

  it('preserves empty snapshot locations as a global search', async () => {
    mocks.turnFindFirst.mockResolvedValue({
      id: 'turn-1', sessionId: 'session-1', userId: 'user-1', rootTaskId: 'root-1', source: 'automation',
      input: { scheduledAutomationSnapshot: snapshot({ targetRoles: ['Saved engineer'], targetLocations: [] }) },
    })
    const { POST } = await import('./route')
    const response = await POST(request({ ...payload, targetRoles: ['Model manager'], targetLocations: ['Model city'] }))

    expect(response.status).toBe(200)
    expect(mocks.executeDiscover).toHaveBeenCalledWith(
      { targetRoles: ['Saved engineer'], targetLocations: [], pageSize: 2 }, expect.any(Object), expect.any(Object), expect.any(Object),
    )
  })

  it('keeps empty manual locations as a global search', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ ...payload, targetLocations: [] }))

    expect(response.status).toBe(200)
    expect(mocks.executeDiscover).toHaveBeenCalledWith(
      { targetRoles: ['Engineer'], targetLocations: [], pageSize: 2 }, expect.any(Object), expect.any(Object), expect.any(Object),
    )
  })

  it.each([
    ['too few roles', Array(schemaTargetBound('targetRoles', 'minItems') - 1).fill('Role'), payload.targetLocations],
    ['too many roles', Array(schemaTargetBound('targetRoles', 'maxItems') + 1).fill('Role'), payload.targetLocations],
    ['too many locations', payload.targetRoles, Array(schemaTargetBound('targetLocations', 'maxItems') + 1).fill('Location')],
    ['overlong role', ['x'.repeat(schemaTargetBound('targetRoles', 'maxLength') + 1)], payload.targetLocations],
    ['overlong location', payload.targetRoles, ['x'.repeat(schemaTargetBound('targetLocations', 'maxLength') + 1)]],
  ] as const)('rejects request criteria outside the search schema: %s', async (_label, targetRoles, targetLocations) => {
    const { POST } = await import('./route')
    const response = await POST(request({ ...payload, targetRoles, targetLocations }))

    expect(response.status).toBe(400)
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it.each([
    ['missing snapshot', {}],
    ['invalid snapshot object', { scheduledAutomationSnapshot: null }],
    ['version mismatch', { scheduledAutomationSnapshot: snapshot({ schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v2' }) }],
    ['out-of-range snapshot roles', {
      scheduledAutomationSnapshot: snapshot({ targetRoles: Array(schemaTargetBound('targetRoles', 'maxItems') + 1).fill('Role') }),
    }],
    ['out-of-range snapshot locations', {
      scheduledAutomationSnapshot: snapshot({ targetLocations: Array(schemaTargetBound('targetLocations', 'maxItems') + 1).fill('Location') }),
    }],
    ['overlong snapshot role', {
      scheduledAutomationSnapshot: snapshot({ targetRoles: ['x'.repeat(schemaTargetBound('targetRoles', 'maxLength') + 1)] }),
    }],
    ['overlong snapshot location', {
      scheduledAutomationSnapshot: snapshot({ targetLocations: ['x'.repeat(schemaTargetBound('targetLocations', 'maxLength') + 1)] }),
    }],
  ] as const)('fails closed before discovery for an automation Turn with %s', async (_label, turnInput) => {
    mocks.turnFindFirst.mockResolvedValue({
      id: 'turn-1', sessionId: 'session-1', userId: 'user-1', rootTaskId: 'root-1', source: 'automation', input: turnInput,
    })
    const { POST } = await import('./route')
    const response = await POST(request(payload))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_scheduled_automation_snapshot' } })
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it('reports provider-call failures separately from failed jobs', async () => {
    mocks.executeDiscover.mockImplementationOnce(async (_input: JobsSearchInput, _context: DiscoveryToolContext, _deps: DiscoveryToolDependencies, usage: ToolUsageState) => {
      usage.requests = 2
      usage.jobsProcessed = 1
      usage.jobsSucceeded = 1
      usage.providerFailures = 1
      usage.providers.add('adzuna')
      usage.providers.add('greenhouse')
      return { jobs: [], evidence: [], nextCursor: null }
    })

    const { POST } = await import('./route')
    const response = await POST(request(payload))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.usage).toMatchObject({
      requests: 2, jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0,
      providerFailures: 1, providers: ['adzuna', 'greenhouse'],
    })
  })

  it('rejects missing secrets, extra identity fields, and role assertions before discovery', async () => {
    const { POST } = await import('./route')
    expect((await POST(request(payload, {}))).status).toBe(401)
    expect((await POST(request({ ...payload, role: 'analyst' }))).status).toBe(400)
    expect((await POST(request({ ...payload, ownerId: 'forged-worker' }))).status).toBe(400)
    expect((await POST(request({ ...payload, turnSource: 'automation' }))).status).toBe(400)
    expect((await POST(request({ ...payload, leaseOwner: undefined }))).status).toBe(400)
    expect((await POST(request({ ...payload, attemptCount: undefined }))).status).toBe(400)
    expect((await POST(request({ ...payload, attemptCount: -1 }))).status).toBe(400)
    expect((await POST(request({ ...payload, attemptCount: 0 }))).status).toBe(400)
    expect((await POST(request({ ...payload, targetRoles: [] }))).status).toBe(400)
    expect((await POST(request({ ...payload, pageSize: 51 }))).status).toBe(400)
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it('fails closed for cross-tenant Turn scope and selected-job Scout tasks', async () => {
    const { POST } = await import('./route')
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    expect((await POST(request(payload))).status).toBe(404)
    expect(mocks.executeDiscover).not.toHaveBeenCalled()

    mocks.sessionFindFirst.mockResolvedValue({ id: 'session-1' })
    mocks.taskFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === 'root-1'
      ? { id: 'root-1' }
      : { id: 'scout-1', allowedActions: ['jobs.get'] })
    expect((await POST(request(payload))).status).toBe(404)
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it('rejects a mismatched root or inactive child even when the posted role says scout', async () => {
    const { POST } = await import('./route')
    mocks.turnFindFirst.mockResolvedValueOnce({ id: 'turn-1', rootTaskId: 'another-root' })
    expect((await POST(request(payload))).status).toBe(404)
    expect(mocks.executeDiscover).not.toHaveBeenCalled()

    mocks.turnFindFirst.mockResolvedValue({ id: 'turn-1', rootTaskId: 'root-1' })
    mocks.taskFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === 'root-1' ? null : null)
    expect((await POST(request(payload))).status).toBe(404)
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it.each([
    ['replaced leaseOwner', { leaseOwner: 'worker-old', attemptCount: 4 }, { leaseOwner: 'worker-current', attemptCount: 4 }],
    ['replaced attemptCount', { leaseOwner: 'worker-1', attemptCount: 3 }, { leaseOwner: 'worker-1', attemptCount: 4 }],
  ])('rejects a stale %s while the replacement Scout lease is active', async (_label, requestAttempt, currentAttempt) => {
    activeChildAttempt = { ...currentAttempt, leaseExpiresAt: new Date(Date.now() + 60_000) }
    const { POST } = await import('./route')
    const response = await POST(request({ ...payload, ...requestAttempt }))

    expect(response.status).toBe(404)
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: 'scout-1', status: 'running', leaseOwner: requestAttempt.leaseOwner, attemptCount: requestAttempt.attemptCount,
      leaseExpiresAt: { gt: expect.any(Date) },
    }) }))
    expect(mocks.executeDiscover).not.toHaveBeenCalled()
  })

  it('rechecks the preflight attempt after provider I/O and writes no Job when the attempt is replaced', async () => {
    let markProviderStarted: () => void = () => undefined
    let resumeProvider: () => void = () => undefined
    const providerStarted = new Promise<void>(resolve => { markProviderStarted = resolve })
    const providerGate = new Promise<void>(resolve => { resumeProvider = resolve })
    const writes: Record<string, unknown>[] = []
    const job = { findMany: vi.fn(async () => []), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data)
      return { id: String(data.id) }
    }) }
    const transactionDb = {
      job,
      async $transaction<T>(callback: (tx: Record<string, unknown>) => Promise<T>): Promise<T> {
        const tx = {
          job,
          $executeRaw: vi.fn(async () => 1),
          $executeRawUnsafe: vi.fn(async () => 1),
          $queryRaw: vi.fn(async <T>(query: { sql: string }): Promise<T> => {
            const sql = query.sql
            if (sql.includes('FROM "agent_sessions"')) return [{ id: 'session-1', status: 'running' }] as T
            if (sql.includes('FROM "agent_turns"')) return [{ id: 'turn-1', rootTaskId: 'root-1', status: 'in_progress' }] as T
            if (sql.includes('FROM "agent_steps"')) return [{ id: 'step-1' }] as T
            if (sql.includes('clock_timestamp()')) return [{ status: 'running', interruptRequestedAt: null, closedAt: null,
              leaseOwner: 'worker-2', attemptCount: 5, live: true }] as T
            if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("'scout'")) return [] as T
            if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: 'root-1' }] as T
            throw new Error(`Unexpected scope SQL: ${sql}`)
          }),
        }
        return callback(tx)
      },
    } as unknown as DiscoveryJobMaterializerDatabase
    const candidate = {
      title: 'Engineer', company: 'Acme', location: 'Dublin', url: 'https://jobs.example/1',
      description: 'Role', salary: null, logo: null, source: 'greenhouse',
    }
    const [{ POST }, { materializeDiscoveredJobs }] = await Promise.all([
      import('./route'), import('@/lib/agent/discovery-job-materializer'),
    ])
    mocks.executeDiscover.mockImplementationOnce(async (_input: JobsSearchInput, _context: DiscoveryToolContext,
      dependencies: DiscoveryToolDependencies, _usage: ToolUsageState) => {
      markProviderStarted()
      await providerGate
      return materializeDiscoveredJobs('user-1', [candidate], undefined, dependencies.executionFence, { db: transactionDb })
        .then(() => ({ jobs: [], evidence: [], nextCursor: null }))
    })

    const pending = POST(request(payload))
    await providerStarted
    activeChildAttempt = { leaseOwner: 'worker-2', attemptCount: 5, leaseExpiresAt: new Date(Date.now() + 60_000) }
    resumeProvider()
    const response = await pending

    expect(response.status).toBe(404)
    expect(writes).toHaveLength(0)
  })
})
