import { describe, expect, it, vi } from 'vitest'
import { withAgentSearchFootprintSessionSnapshot } from './agent-search-footprint-session-snapshot'

function tx(enabled: boolean, version: number) {
  return {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => ({
      agentSearchFootprintMemoryEnabled: enabled, agentSearchFootprintMemoryConsentVersion: version,
    })) },
    agentSession: { create: vi.fn() },
  }
}

describe('agent search footprint Session consent snapshot', () => {
  it('reads and captures the current choice inside the same locked creation transaction', async () => {
    const transaction = tx(true, 7)
    const root = { $transaction: vi.fn(async (work: (value: never) => unknown) => work(transaction as never)) }
    const result = await withAgentSearchFootprintSessionSnapshot(root, 'user-1', async (sameTx, snapshot, captured) => {
      expect(sameTx).toBe(transaction)
      expect(captured).toBe(true)
      return snapshot
    })
    expect(result).toEqual({ enabled: true, version: 7 })
    expect(root.$transaction).toHaveBeenCalledOnce()
    expect(transaction.$queryRaw).toHaveBeenCalledOnce()
    expect(transaction.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: {
      agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true,
    } })
  })

  it('captures default-off consent and reuses an already-owned transaction', async () => {
    const transaction = tx(false, 0)
    const result = await withAgentSearchFootprintSessionSnapshot(transaction, 'user-2', async (_sameTx, snapshot, captured) => ({ snapshot, captured }))
    expect(result).toEqual({ snapshot: { enabled: false, version: 0 }, captured: true })
    expect(transaction.$queryRaw).toHaveBeenCalledOnce()
  })

  it('fails closed for minimal persistence doubles that cannot read consent', async () => {
    const result = await withAgentSearchFootprintSessionSnapshot({ agentSession: {} }, 'user-3', async (_sameTx, snapshot, captured) => ({ snapshot, captured }))
    expect(result).toEqual({ snapshot: { enabled: false, version: 0 }, captured: false })
  })
})
