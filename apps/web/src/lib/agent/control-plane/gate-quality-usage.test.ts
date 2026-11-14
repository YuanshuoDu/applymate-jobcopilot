import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admit: vi.fn(), start: vi.fn(), settle: vi.fn(), settleInTransaction: vi.fn(), reconcile: vi.fn(), prepare: vi.fn(), chat: vi.fn(), estimate: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/model-router', () => ({ estimateAiCostUsd: mocks.estimate, prepareReservedModelTransport: mocks.prepare }))
vi.mock('./agent-usage-reconciliation', () => ({ reconcileAbandonedAgentUsage: mocks.reconcile }))
vi.mock('./usage-broker', () => ({ admitAiUsageInTransaction: mocks.admit,
  startAiUsageInTransaction: mocks.start, settleAiUsage: mocks.settle, settleAiUsageInTransaction: mocks.settleInTransaction }))

import { createGateQualityUsageCaller, type GateQualityValidatedOwner } from './gate-quality-usage'

const owner: GateQualityValidatedOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1',
  rootTaskId: 'root-1', gateTaskId: 'gate-1', gateLeaseOwnerId: 'gate-lease-1', gateAttemptCount: 2,
  executionId: 'execution-1', executionAttemptCount: 1, continuationKey: 'continuation-1', claimToken: 'claim-1' }
const messages = [{ role: 'user' as const, content: 'Review this application.' }]
const call = { jobId: 'job-1', config: { provider: 'minimax' as const, model: 'MiniMax-M3', apiKey: 'private-key' }, messages, maxTokens: 300 }
const result = { text: '{"quality":true}', inputTokens: 12, outputTokens: 8, provider: 'minimax' as const, model: 'MiniMax-M3' }
type PriorEvidence = { stepId: string; inputDigest: string | null; operationId: string | null; usageStatus: string | null;
  reservationStatus: string | null; providerStartedAt: Date | null }

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') }
function evidence(status: 'started' | 'released' = 'started', changedInput = false): PriorEvidence {
  return { stepId: 'old-step', inputDigest: changedInput ? 'different' : hash(messages.map(message => ({ role: message.role, content: message.content }))),
    operationId: 'old-operation', usageStatus: status === 'released' ? 'released' : 'reserved',
    reservationStatus: status === 'released' ? 'released' : 'started', providerStartedAt: status === 'released' ? null : new Date() }
}

function setup(options: { rows?: ReturnType<typeof evidence>[]; currentOwner?: (index: number) => GateQualityValidatedOwner | null;
  serialize?: boolean } = {}) {
  const rows: PriorEvidence[] = [...(options.rows ?? [])], inserted = new Map<string, PriorEvidence>(), closedSteps: unknown[] = []
  let ownerChecks = 0, tail = Promise.resolve()
  const raw = vi.fn(async (query: unknown) => {
    const row = query as { text?: string; values?: unknown[] }, text = row.text ?? ''
    if (text.includes('FROM "agent_steps" AS step')) return rows
    if (text.includes('COALESCE(MAX("ordinal")')) return [{ ordinal: rows.length }]
    if (text.includes('INSERT INTO "agent_steps"')) {
      const profileText = row.values?.find(value => typeof value === 'string' && value.includes('gateQualityReview'))
      if (typeof profileText === 'string') {
        const profile = JSON.parse(profileText) as { gateQualityReview: { logicalReviewKey: string; inputDigest: string } }
        const saved = { stepId: String(row.values?.[0]), inputDigest: profile.gateQualityReview.inputDigest,
          operationId: null, usageStatus: null, reservationStatus: null, providerStartedAt: null }
        rows.push(saved); inserted.set(String(row.values?.[0]), saved)
      }
    }
    if (text.includes('UPDATE "agent_steps" SET "status"')) {
      const values = row.values ?? []
      closedSteps.push({ status: values[0], inputTokens: values[1], outputTokens: values[2], estimatedCostUsd: values[3], errorCode: values[4] })
      return [{ id: String(values[6] ?? 'step') }]
    }
    if (text.includes('UPDATE "agent_steps"') && text.includes("'interrupted'")) return []
    return []
  })
  const tx = { $queryRaw: raw }
  const db = { $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    if (!options.serialize) return work(tx)
    const previous = tail
    let unlock!: () => void
    tail = new Promise<void>(resolve => { unlock = resolve })
    await previous
    try { return await work(tx) } finally { unlock() }
  }) }
  mocks.reconcile.mockResolvedValue(undefined)
  mocks.admit.mockImplementation(async (_tx: unknown, input: { stepId: string }) => {
    const saved = inserted.get(input.stepId)
    if (saved) Object.assign(saved, { operationId: 'operation-' + input.stepId, usageStatus: 'reserved', reservationStatus: 'reserved' })
    return { operationId: 'operation-' + input.stepId, startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 250 }
  })
  mocks.start.mockImplementation(async (_tx: unknown, input: { stepId: string }) => {
    const saved = inserted.get(input.stepId)
    if (saved) Object.assign(saved, { usageStatus: 'reserved', reservationStatus: 'started', providerStartedAt: new Date() })
    return { startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 250 }
  })
  mocks.settle.mockImplementation(async (_db: unknown, input: { operationId: string; status: string }) => {
    const saved = [...inserted.values(), ...rows].find(row => row.operationId === input.operationId)
    if (saved) Object.assign(saved, input.status === 'released'
      ? { usageStatus: 'released', reservationStatus: 'released', providerStartedAt: null }
      : { usageStatus: input.status, reservationStatus: 'settled' })
  })
  mocks.prepare.mockReturnValue({ provider: 'minimax', model: 'MiniMax-M3', credentialSource: 'user', chat: mocks.chat })
  return { db, tx, raw, rows, inserted, closedSteps, lockCurrentOwner: async () => options.currentOwner ? options.currentOwner(ownerChecks++) : owner }
}

beforeEach(() => {
  mocks.admit.mockReset(); mocks.start.mockReset(); mocks.settle.mockReset(); mocks.settleInTransaction.mockReset(); mocks.reconcile.mockReset()
  mocks.estimate.mockReset().mockReturnValue(0.0001)
  mocks.chat.mockReset().mockResolvedValue(result); mocks.prepare.mockReset()
})

describe('scheduled Gate quality usage', () => {
  it('uses the reserved output allowance and settles only actual provider usage', async () => {
    const fixture = setup()
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).resolves.toEqual(result)

    expect(mocks.admit).toHaveBeenCalledOnce()
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.chat).toHaveBeenCalledWith(messages, 250, undefined)
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'success', inputTokens: 12,
      outputTokens: 8, estimatedCostUsd: 0.0001 }))
    expect(fixture.closedSteps).toEqual([{ status: 'completed', inputTokens: 12, outputTokens: 8, estimatedCostUsd: 0.0001, errorCode: null }])
    expect(fixture.rows[0]?.inputDigest).toBe(hash(messages))
  })

  it('does not admit when the claim changed before admission', async () => {
    const fixture = setup({ currentOwner: () => null })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_owner_stale')
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('releases an unstarted admission when the claim changes before start', async () => {
    const fixture = setup({ currentOwner: index => index === 0 ? owner : null })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_owner_stale')
    expect(mocks.admit).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.settle).toHaveBeenCalledWith(fixture.db, expect.objectContaining({ status: 'released' }))
  })

  it('never returns a late result after the claim changes during the provider call', async () => {
    const fixture = setup({ currentOwner: index => index < 2 ? owner : null })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_owner_stale')
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'success' }))
  })

  it('blocks a cross-execution replay when durable evidence says the same review already started', async () => {
    const restartedOwner = { ...owner, executionAttemptCount: 2 }
    const fixture = setup({ rows: [evidence()], currentOwner: () => restartedOwner })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never,
      owner: restartedOwner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_review_already_attempted')
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('fails closed on changed input or missing recovery lineage', async () => {
    const restartedOwner = { ...owner, executionAttemptCount: 2 }
    const changed = setup({ rows: [evidence('started', true)], currentOwner: () => restartedOwner })
    await expect(createGateQualityUsageCaller({ db: changed.db as never, owner: restartedOwner,
      lockCurrentOwner: changed.lockCurrentOwner })(call)).rejects.toThrow('gate_quality_replay_input_changed')
    const missing = setup({ currentOwner: () => restartedOwner })
    await expect(createGateQualityUsageCaller({ db: missing.db as never, owner: restartedOwner,
      lockCurrentOwner: missing.lockCurrentOwner })(call)).rejects.toThrow('gate_quality_replay_lineage_missing')
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('allows only a matching released and unstarted lineage to retry', async () => {
    const restartedOwner = { ...owner, executionAttemptCount: 2 }
    const fixture = setup({ rows: [evidence('released')], currentOwner: () => restartedOwner })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner: restartedOwner,
      lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).resolves.toEqual(result)

    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.admit).toHaveBeenCalledOnce()
  })

  it('serializes competing admissions for the same task and package', async () => {
    const fixture = setup({ serialize: true })
    let finish!: (value: typeof result) => void
    mocks.chat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })(call)
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledOnce())
    const second = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })(call)

    await expect(second).rejects.toThrow('gate_quality_review_already_attempted')
    expect(mocks.chat).toHaveBeenCalledOnce()
    finish(result)
    await expect(first).resolves.toEqual(result)
  })

  it('does not expose a response when usage is unknown or exceeds the admitted cap', async () => {
    const fixture = setup()
    mocks.chat.mockResolvedValueOnce({ ...result, outputTokens: undefined })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_usage_unknown')
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'error', estimatedCostUsd: null }))
    expect(fixture.closedSteps).toEqual([{ status: 'failed', inputTokens: 12, outputTokens: null, estimatedCostUsd: null,
      errorCode: 'gate_quality_usage_unknown' }])
    expect(mocks.settle).not.toHaveBeenCalled()
  })

  it('records actual over-cap usage atomically but never returns the review result', async () => {
    const fixture = setup()
    mocks.chat.mockResolvedValueOnce({ ...result, outputTokens: 251 })
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('gate_quality_usage_unknown')
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'error',
      inputTokens: 12, outputTokens: 251, estimatedCostUsd: 0.0001 }))
    expect(fixture.closedSteps).toEqual([{ status: 'failed', inputTokens: 12, outputTokens: 251, estimatedCostUsd: 0.0001,
      errorCode: 'gate_quality_usage_unknown' }])
  })

  it('keeps custom-provider cost unknown even when the catalogue reports zero', async () => {
    const fixture = setup()
    const customResult = { ...result, provider: 'custom' as const, model: 'custom' }
    const customCall = { ...call, config: { provider: 'custom' as const, model: 'custom',
      apiBase: 'https://api.example/v1', apiKey: 'private-key' } }
    mocks.estimate.mockReturnValue(0)
    mocks.prepare.mockReturnValue({ provider: 'custom', model: 'custom', credentialSource: 'user', chat: mocks.chat })
    mocks.chat.mockResolvedValueOnce(customResult)
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(customCall)).rejects.toThrow('gate_quality_usage_unknown')
    expect(mocks.estimate).not.toHaveBeenCalled()
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'error',
      inputTokens: 12, outputTokens: 8, estimatedCostUsd: null, errorCode: 'gate_quality_usage_unknown' }))
    expect(fixture.closedSteps).toEqual([{ status: 'failed', inputTokens: 12, outputTokens: 8, estimatedCostUsd: null,
      errorCode: 'gate_quality_usage_unknown' }])
    expect(mocks.settle).not.toHaveBeenCalled()
  })

  it('keeps error usage unknown and writes null Step usage in the same transaction', async () => {
    const fixture = setup()
    mocks.chat.mockRejectedValueOnce(new Error('provider interrupted'))
    const caller = createGateQualityUsageCaller({ db: fixture.db as never, owner, lockCurrentOwner: fixture.lockCurrentOwner })

    await expect(caller(call)).rejects.toThrow('provider interrupted')
    expect(mocks.settleInTransaction).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ status: 'error',
      inputTokens: null, outputTokens: null, estimatedCostUsd: null }))
    expect(fixture.closedSteps).toEqual([{ status: 'failed', inputTokens: null, outputTokens: null, estimatedCostUsd: null,
      errorCode: 'gate_quality_provider_error' }])
  })
})
