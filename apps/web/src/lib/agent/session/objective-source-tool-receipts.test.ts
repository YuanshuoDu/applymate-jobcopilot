import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ context: vi.fn(), resolve: vi.fn(), readSet: vi.fn(), prove: vi.fn() }))
vi.mock('./objective-journey-report-source', () => ({ readObjectiveJourneyProofContext: mocks.context }))
vi.mock('./objective-journey-report-requirement-receipts', () => ({ readObjectiveTaskToolReceiptSet: mocks.readSet }))
vi.mock('./objective-source-tool-receipt-proof', () => ({
  resolveObjectiveSourceToolScope: mocks.resolve,
  proveObjectiveSourceToolReceipts: mocks.prove,
}))

import { readObjectiveSourceToolReceipts } from './objective-source-tool-receipts'

const input = { userId: 'user-1', sessionId: 'session-1', finalItemId: 'final-1', sourceKey: `src_${'a'.repeat(43)}`, graphRevision: 7 }
const context = { userId: input.userId, sessionId: input.sessionId, finalItemId: input.finalItemId, graphRevision: input.graphRevision }
const resolved = { role: 'analyst', scope: { taskId: 'analyst-task', attemptCount: 2 } }
const projection = {
  schemaVersion: 'agent-harness.v2.objective-tool-receipt-evidence.v1', graphRevision: input.graphRevision,
  sourceKey: input.sourceKey, role: 'analyst',
  receipts: [{ ordinal: 1, receiptKey: `rcp_${'b'.repeat(43)}`, toolName: 'jobs.get', delivery: 'replayed' }],
}

describe('Objective source tool receipt reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.context.mockResolvedValue(context)
    mocks.resolve.mockReturnValue(resolved)
    mocks.readSet.mockResolvedValue({ items: [] })
    mocks.prove.mockReturnValue(projection)
  })

  it('uses the exact owner context, resolved scope, and proof projection', async () => {
    const tx = {} as never
    await expect(readObjectiveSourceToolReceipts(tx, input)).resolves.toEqual(projection)
    expect(mocks.context).toHaveBeenCalledWith(tx, input, 7)
    expect(mocks.resolve).toHaveBeenCalledWith(context, input.sourceKey)
    expect(mocks.readSet).toHaveBeenCalledWith(tx, resolved.scope)
    expect(mocks.prove).toHaveBeenCalledWith(context, resolved, { items: [] })
  })

  it.each([
    { ...input, graphRevision: 0 }, { ...input, sourceKey: 'src_foreign' }, { ...input, userId: '' },
  ])('rejects invalid request identity before protected reads', async value => {
    await expect(readObjectiveSourceToolReceipts({} as never, value)).resolves.toBeUndefined()
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('fails closed for missing, stale, foreign, malformed, or empty proof', async () => {
    mocks.context.mockResolvedValueOnce(null)
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    mocks.context.mockResolvedValueOnce({ graphRevision: 8 })
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    mocks.resolve.mockReturnValueOnce(undefined)
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    mocks.prove.mockReturnValueOnce({ receipts: [] })
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    expect(mocks.readSet).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite a proof that names a different source or graph revision', async () => {
    mocks.prove.mockReturnValueOnce({ ...projection, sourceKey: `src_${'z'.repeat(43)}` })
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    mocks.prove.mockReturnValueOnce({ ...projection, graphRevision: 8 })
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    mocks.prove.mockReturnValueOnce({ ...projection, role: 'scout' })
    await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
  })

  it('rejects a context signed for another owner, session, or final item', async () => {
    for (const field of ['userId', 'sessionId', 'finalItemId'] as const) {
      mocks.context.mockResolvedValueOnce({ ...context, [field]: `foreign-${field}` })
      await expect(readObjectiveSourceToolReceipts({} as never, input)).resolves.toBeUndefined()
    }
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.readSet).not.toHaveBeenCalled()
  })
})
