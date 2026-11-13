import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), queryRaw: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof NextResponse }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }))
import { GET } from './route'

function capturedSql(call: readonly unknown[]) {
  const [template, ...values] = call
  if (!Array.isArray(template) || !('raw' in template)) throw new Error('Expected a Prisma tagged query')
  const query = Prisma.sql(template as TemplateStringsArray, ...(values as never[]))
  return { text: query.text, values: query.values }
}

describe('GET /api/admin/v1/ai/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'))
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', permissions: ['ai_budget.read'], roleKey: 'ops', requestId: 'req-1' })
    mocks.queryRaw
      .mockResolvedValueOnce([{ day: new Date('2026-11-12T00:00:00Z'), calls: 2, errors: 1, cost: 0.03, avgLatency: 80 }])
      .mockResolvedValueOnce([{ provider: 'minimax', model: 'MiniMax-M3', calls: 2, errors: 1, cost: 0.03, avgLatency: 80 }])
  })

  afterEach(() => vi.useRealTimers())

  it('counts completed success and error usage while excluding pending reservations', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/ai/usage?days=7'))
    const payload = await response.json()

    expect(payload.summary).toMatchObject({ calls: 2, errors: 1, costUsd: 0.03 })
    expect(payload.providers).toEqual([expect.objectContaining({ provider: 'minimax', model: 'MiniMax-M3', calls: 2, errors: 1, cost: 0.03 })])
    const statements = mocks.queryRaw.mock.calls.map(capturedSql)
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
      expect(statement.text).toContain("status IN ('success', 'error')")
      expect(statement.text).toContain('created_at >= $1')
      expect(statement.values[0]).toEqual(new Date('2026-11-06T12:00:00.000Z'))
    }
  })
})
