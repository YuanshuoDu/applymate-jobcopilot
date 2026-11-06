import React from 'react'
import { renderToString } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'

// Exercise the actual hook, mutation helper and route; only identity, persistence
// and the network boundary are fixtures. This does not prove database locking.
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn(), activity: vi.fn(),
  transaction: vi.fn(), entitlement: vi.fn(), purge: vi.fn(),
}))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: async () => ({ userId: 'user-1' }),
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { job: { findFirst: mocks.findFirst, count: mocks.count }, $transaction: mocks.transaction } }))
vi.mock('@/lib/entitlements', () => ({ checkEntitlementLimit: mocks.entitlement }))
vi.mock('@/lib/cover-letter-retention', () => ({ purgeTemporaryGeneratedCoverLetters: mocks.purge }))

import { POST } from './route'
import { useAgentPlaygroundActions } from '@/components/pages/useAgentPlaygroundActions'

const job: ApplyReadyJob = { jobId: 'job-1', company: 'Example', role: 'Engineer', score: 80, url: 'https://example.test', matchedKeywords: [] }
const conflictMessage = 'Application state changed. Refresh the application before recording.'

function mount() {
  let queue = [{ ...job }]
  const toast = { success: vi.fn(), error: vi.fn() }
  let actions: ReturnType<typeof useAgentPlaygroundActions> | undefined
  function Harness() {
    actions = useAgentPlaygroundActions({
      toast: toast as unknown as Parameters<typeof useAgentPlaygroundActions>[0]['toast'],
      addLog: vi.fn(), setRunLog: vi.fn(), setWaitingQuestion: vi.fn(),
      setApplyQueue: update => { queue = typeof update === 'function' ? update(queue) : update },
    })
    return null
  }
  renderToString(React.createElement(Harness))
  const getActions = (): ReturnType<typeof useAgentPlaygroundActions> | undefined => actions
  const renderedActions = getActions()
  if (!renderedActions) throw new Error('hook did not mount')
  return { actions: renderedActions, toast, getQueue: () => queue }
}

describe('manual-record compatibility with the Agent playground', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.findFirst.mockResolvedValue({ id: 'job-1', company: 'Example', role: 'Engineer' })
    mocks.count.mockResolvedValue(0)
    mocks.entitlement.mockResolvedValue({ allowed: true })
    mocks.activity.mockResolvedValue({})
    mocks.purge.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ job: { updateMany: mocks.updateMany }, activity: { create: mocks.activity } }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/jobs/job-1/apply')
      const req = new NextRequest(`http://localhost${url}`, { ...init, signal: init.signal ?? undefined })
      // The existing Agent caller sends no correlated manual-record request ID.
      expect(req.headers.get('X-Manual-Record-Request-Id')).toBeNull()
      return POST(req, { params: Promise.resolve({ id: 'job-1' }) })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('marks the original queue item and shows success after a successful record', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const fixture = mount()
    await fixture.actions.handleApplied(job.jobId, job)
    expect(fixture.getQueue()[0].url).toBe('_applied_https://example.test')
    expect(fixture.toast.success).toHaveBeenCalledWith('agent.markedForDelivery', 'Example · Engineer')
    expect(fixture.toast.error).not.toHaveBeenCalled()
    expect(mocks.activity).toHaveBeenCalledOnce()
  })

  it('shows the route conflict and leaves the original queue item unchanged', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const fixture = mount()
    await expect(fixture.actions.handleApplied(job.jobId, job)).rejects.toThrow(conflictMessage)
    expect(fixture.getQueue()).toEqual([job])
    expect(fixture.toast.error).toHaveBeenCalledWith('agent.deliveryFailed', conflictMessage)
    expect(fixture.toast.success).not.toHaveBeenCalled()
    expect(mocks.activity).not.toHaveBeenCalled()
  })
})
