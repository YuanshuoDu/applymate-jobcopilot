import { describe, expect, it, vi } from 'vitest'
import { acknowledgeCommittedAtsPolicy } from './ats-policy-propagation'

const command = {
  requestId: 'request-1',
  actorId: 'admin-1',
  sourceKey: 'lever',
  version: 4,
  reason: 'Applying a reviewed provider policy change',
}

describe('ATS policy propagation', () => {
  it('records an acknowledgement only when the Worker confirms the committed version', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: 'worker-1', acknowledgedVersion: 4 })
    const markAcknowledged = vi.fn().mockResolvedValue(1)

    await expect(acknowledgeCommittedAtsPolicy(command, { send, markAcknowledged })).resolves.toBe('acknowledged')

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      action: 'apply_ats_policy',
      params: { sourceKey: 'lever', version: 4 },
    }))
    expect(markAcknowledged).toHaveBeenCalledWith('lever', 4)
  })

  it('keeps propagation pending when the Worker returns a stale version', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: 'worker-1', acknowledgedVersion: 3 })
    const markAcknowledged = vi.fn()

    await expect(acknowledgeCommittedAtsPolicy(command, { send, markAcknowledged })).resolves.toBe('pending')

    expect(markAcknowledged).not.toHaveBeenCalled()
  })

  it('keeps propagation pending when the control plane cannot be reached', async () => {
    const send = vi.fn().mockRejectedValue(new Error('worker unavailable'))
    const markAcknowledged = vi.fn()

    await expect(acknowledgeCommittedAtsPolicy(command, { send, markAcknowledged })).resolves.toBe('pending')

    expect(markAcknowledged).not.toHaveBeenCalled()
  })
})
