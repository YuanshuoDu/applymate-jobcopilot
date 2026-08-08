import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ loadPolicy: vi.fn() }))

vi.mock('../queue/apply-queue.js', () => ({
  applyQueue: { pause: vi.fn(), resume: vi.fn(), getJobCounts: vi.fn(), isPaused: vi.fn() },
  connection: { set: vi.fn() },
}))
vi.mock('../queue/scout-queue.js', () => ({ scoutQueue: { pause: vi.fn(), resume: vi.fn(), getJobCounts: vi.fn(), isPaused: vi.fn() } }))
vi.mock('../queue/agent-run-queue.js', () => ({ agentRunQueue: { pause: vi.fn(), resume: vi.fn(), getJobCounts: vi.fn(), isPaused: vi.fn() } }))
vi.mock('./ats-policy.js', () => ({ loadEffectiveAtsPolicy: mocks.loadPolicy }))

import { applyAtsPolicyCommand } from './control-plane.js'

describe('ATS control-plane acknowledgement', () => {
  it('acknowledges only the version loaded from the committed policy row', async () => {
    mocks.loadPolicy.mockResolvedValue({ configured: true, version: 4 })

    await expect(applyAtsPolicyCommand({ query: vi.fn() } as unknown as Pool, { sourceKey: 'lever', version: 4 }))
      .resolves.toEqual({ acknowledgedVersion: 4 })
  })

  it('rejects a stale requested policy version', async () => {
    mocks.loadPolicy.mockResolvedValue({ configured: true, version: 4 })

    await expect(applyAtsPolicyCommand({ query: vi.fn() } as unknown as Pool, { sourceKey: 'lever', version: 5 }))
      .rejects.toThrow('not committed')
  })
})
