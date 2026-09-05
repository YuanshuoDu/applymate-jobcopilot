import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getStage: vi.fn(),
  summarize: vi.fn(),
  decideAdvance: vi.fn(),
  rollbackTarget: vi.fn(),
  stageTransitionData: vi.fn(),
  mutation: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/rollout/diff-store', () => ({ summarizeRolloutDiffs: mocks.summarize }))
vi.mock('@/lib/rollout/stage-controller', () => ({
  getRolloutStage: mocks.getStage,
  parseEnvironment: (value: string | null | undefined) => value ?? 'staging',
  decideAdvance: mocks.decideAdvance,
  rollbackTarget: mocks.rollbackTarget,
  stageTransitionData: mocks.stageTransitionData,
}))
vi.mock('@/lib/rollout/flags', () => ({
  ROLLOUT_STAGES: [{ key: 'internal-only', rolloutPercent: 0, observationMs: 24 * 60 * 60 * 1000 }],
  ROLLBACK_THRESHOLDS: {},
  isObservationComplete: () => true,
  observationWindow: () => ({ start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-01T04:00:00.000Z') }),
  evaluateRollbackThresholds: () => ({ shouldRollback: false, reasons: [], metrics: null }),
}))

const admin = { userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' }
const current = {
  environment: 'staging', stageKey: 'internal-only', rolloutPercent: 0, enabled: true, internalUserIds: [],
  observationStartedAt: new Date('2026-01-01T00:00:00.000Z'), observationEndsAt: new Date('2026-01-02T00:00:00.000Z'),
  version: 1, status: 'active', rollbackReason: null, lastTransitionAt: new Date('2026-01-01T00:00:00.000Z'),
}

function request(method: 'GET' | 'POST', path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'rollout-key-1' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('rollout admin API RBAC', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.getStage.mockResolvedValue({ stage: current, persisted: true })
    mocks.summarize.mockResolvedValue({ total: 0, withinThreshold: 0, byMetric: {} })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { count: 1 } })
    mocks.stageTransitionData.mockReturnValue({ stageKey: '1%', version: { increment: 1 } })
    mocks.rollbackTarget.mockReturnValue('internal-only')
  })

  it.each([
    ['status', async () => (await import('./status/route')).GET(request('GET', '/api/rollout/status'))],
    ['advance', async () => (await import('./advance/route')).POST(request('POST', '/api/rollout/advance', { reason: 'operator test reason', metrics: { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 } }))],
    ['rollback', async () => (await import('./rollback/route')).POST(request('POST', '/api/rollout/rollback', { reason: 'operator test reason', metrics: { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 } }))],
  ] as const)('rejects a visitor on %s', async (_name, load) => {
    mocks.requireAdmin.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    const response = await load()
    expect(response.status).toBe(403)
  })

  it('allows an admin to read rollout status', async () => {
    mocks.requireAdmin.mockResolvedValue(admin)
    const { GET } = await import('./status/route')
    const response = await GET(request('GET', '/api/rollout/status'))
    expect(response.status).toBe(200)
    expect((await response.json()).current.stage).toBe('internal-only')
  })

  it('allows an admin to advance and rollback with an idempotency key', async () => {
    mocks.requireAdmin.mockResolvedValue(admin)
    mocks.decideAdvance.mockReturnValue({ ok: true, targetStage: '1%', observation: { start: new Date(), end: new Date() } })
    const advance = await import('./advance/route')
    const advanced = await advance.POST(request('POST', '/api/rollout/advance', { reason: 'Advance after complete observation', metrics: { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 } }))
    expect(advanced.status).toBe(200)

    const rollback = await import('./rollback/route')
    const rolledBack = await rollback.POST(request('POST', '/api/rollout/rollback', { reason: 'Rollback after operator review' }))
    expect(rolledBack.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledTimes(2)
  })
})
