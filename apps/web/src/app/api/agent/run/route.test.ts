import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { legacyTrafficSnapshot } from '@/lib/observability/legacy-counter'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  sessionFindFirst: vi.fn(),
  turnFindFirst: vi.fn(),
  sseResponse: vi.fn(),
  runAgentPipeline: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  sseResponse: mocks.sseResponse,
}))

vi.mock('@/lib/db', () => ({
  db: {
    agentSession: { findFirst: mocks.sessionFindFirst },
    agentTurn: { findFirst: mocks.turnFindFirst },
  },
}))
vi.mock('@/lib/entitlements', () => ({ hasEffectiveEntitlement: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/agent/run-service', () => ({ runAgentPipeline: mocks.runAgentPipeline }))

// This test exits before the SSE callback runs. Mock its heavy dependencies so
// the session-ownership assertion stays isolated when the full suite is busy.
vi.mock('@/lib/agent/pipeline', () => ({ runPipeline: vi.fn() }))
vi.mock('@/lib/agent/session/run-recorder', () => ({ createRunSessionRecorder: vi.fn() }))
vi.mock('@/lib/agent/role-config', () => ({
  loadRoleConfigs: vi.fn(),
  toRoleConfigMap: vi.fn(),
}))

describe('agent run API session binding', () => {
  beforeEach(() => {
    mocks.prepareAiRoute.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.turnFindFirst.mockReset()
    mocks.sseResponse.mockReset()
    mocks.runAgentPipeline.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
  })

  it('refuses to start a pipeline for a deleted or foreign requested session', async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import('./route')
    const before = legacyTrafficSnapshot()

    const response = await GET(new NextRequest('http://localhost/api/agent/run?sessionId=deleted_session') as never)
    if (!response) throw new Error('Expected a response')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Session not found' })
    expect(mocks.prepareAiRoute).toHaveBeenCalledWith(expect.any(NextRequest), 'agent', 'job_discovery')
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { id: 'deleted_session', userId: 'user_1' },
      select: { id: true },
    })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.sseResponse).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
    expect(legacyTrafficSnapshot().windowByKey.agent_run_endpoint).toBe(before.windowByKey.agent_run_endpoint + 1)
    expect(legacyTrafficSnapshot().windowByKey.agent_stream_connect).toBe(before.windowByKey.agent_stream_connect + 1)
  })

  it.each(['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'])(
    'blocks the legacy pipeline when a canonical turn is active (%s)',
    async status => {
      mocks.sessionFindFirst.mockResolvedValueOnce({ id: 'session_1' })
      mocks.turnFindFirst.mockResolvedValueOnce({ id: `turn_${status}` })
      const { GET } = await import('./route')

      const response = await GET(new NextRequest('http://localhost/api/agent/run?sessionId=session_1') as never)
      if (!response) throw new Error('Expected a response')

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        error: 'A canonical agent turn is already active for this session.',
        code: 'legacy_agent_run_blocked_by_active_turn',
      })
      expect(mocks.turnFindFirst).toHaveBeenCalledWith({
        where: {
          sessionId: 'session_1',
          userId: 'user_1',
          status: { in: ['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'] },
        },
        select: { id: true },
      })
      expect(mocks.sseResponse).not.toHaveBeenCalled()
      expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
    },
  )

  it('preserves the legacy SSE path when the owned session has no active canonical turn', async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce({ id: 'session_1' })
    mocks.turnFindFirst.mockResolvedValueOnce(null)
    mocks.sseResponse.mockReturnValueOnce(new Response('legacy-sse', { status: 200 }))
    const { GET } = await import('./route')

    const response = await GET(new NextRequest('http://localhost/api/agent/run?sessionId=session_1&autonomous=true') as never)
    if (!response) throw new Error('Expected a response')

    expect(response.status).toBe(200)
    expect(mocks.sseResponse).toHaveBeenCalledTimes(1)
    expect(mocks.sseResponse).toHaveBeenCalledWith(expect.any(Function))
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it('preserves the legacy SSE path when no session is supplied', async () => {
    mocks.sseResponse.mockReturnValueOnce(new Response('legacy-sse', { status: 200 }))
    const { GET } = await import('./route')

    const response = await GET(new NextRequest('http://localhost/api/agent/run') as never)
    if (!response) throw new Error('Expected a response')

    expect(response.status).toBe(200)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.sseResponse).toHaveBeenCalledTimes(1)
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })
})
