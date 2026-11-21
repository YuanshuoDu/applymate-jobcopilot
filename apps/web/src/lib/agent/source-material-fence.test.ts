import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentSourceMaterialFenceKey } from '@jobcopilot/shared'
import { acquireSourceMaterialFence } from './source-material-fence'

type RawQueryCall = { sql: string; values: unknown[] }
const INVALID_FENCE_TRANSACTION = 'source material fence transaction verification failed'
const SENSITIVE_DATABASE_ERROR = 'database URL=postgres://private-user-id:secret@db.example/app xid=8675309'

type SimulatedDatabaseError = Error & Record<string, unknown>

function makeDatabaseError(properties: Record<string, unknown> = {}): SimulatedDatabaseError {
  return Object.assign(new Error(SENSITIVE_DATABASE_ERROR), {
    detail: SENSITIVE_DATABASE_ERROR,
    table: 'private_table',
    retryable: true,
    shouldRetry: true,
    retryAfterMs: 30000,
    cause: new Error(SENSITIVE_DATABASE_ERROR),
    ...properties,
  }) as unknown as SimulatedDatabaseError
}

const DATABASE_ERROR_CASES: Array<{
  name: string
  error: SimulatedDatabaseError
  code?: string
  metaCode?: string
}> = [
  { name: 'PostgreSQL deadlock', error: makeDatabaseError({ code: '40P01' }), code: '40P01' },
  { name: 'PostgreSQL serialization failure', error: makeDatabaseError({ code: '40001' }), code: '40001' },
  {
    name: 'Prisma raw query error',
    error: makeDatabaseError({ code: 'P2010', meta: { code: '40001', message: SENSITIVE_DATABASE_ERROR, query: SENSITIVE_DATABASE_ERROR } }),
    code: 'P2010',
    metaCode: '40001',
  },
  { name: 'Prisma transaction conflict', error: makeDatabaseError({ code: 'P2034' }), code: 'P2034' },
  { name: 'unknown database code', error: makeDatabaseError({ code: 'X1234', meta: { code: 'X1234' } }) },
  { name: 'unknown sensitive error', error: makeDatabaseError() },
]

function makeTransaction(onQuery: (callIndex: number) => Promise<unknown> = async () => [{ transaction_id: '17' }]) {
  const calls: RawQueryCall[] = []
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return onQuery(calls.length)
  })

  return {
    tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
    calls,
  }
}

describe('acquireSourceMaterialFence', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses a parameterized query with the shared key and does not log user identifiers', async () => {
    const userId = "user-'private-id"
    const { tx, calls } = makeTransaction()
    const loggers = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ]

    await acquireSourceMaterialFence(tx, [userId])

    expect(calls).toEqual([{
      sql: 'SELECT pg_current_xact_id()::text AS transaction_id, pg_advisory_xact_lock(hashtextextended(?::text, 0))::text AS lock_acquired',
      values: [buildAgentSourceMaterialFenceKey(userId)],
    }, {
      sql: 'SELECT pg_current_xact_id()::text AS transaction_id',
      values: [],
    }])
    expect(calls[0]?.sql).not.toContain(userId)
    for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
  })

  it('awaits locks sequentially for sorted, deduplicated user IDs', async () => {
    let markFirstStarted: () => void = () => undefined
    let releaseFirstLock: () => void = () => undefined
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstCanFinish = new Promise<void>(resolve => { releaseFirstLock = resolve })
    const { tx, calls } = makeTransaction(async callIndex => {
      if (callIndex === 1) {
        markFirstStarted()
        await firstCanFinish
      }
      return [{ transaction_id: '17' }]
    })

    const acquisition = acquireSourceMaterialFence(tx, ['user-c', 'user-a', 'user-b', 'user-a'])
    await firstStarted

    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual([buildAgentSourceMaterialFenceKey('user-a')])

    releaseFirstLock()
    await acquisition

    expect(calls.map(call => call.values)).toEqual([
      [buildAgentSourceMaterialFenceKey('user-a')],
      [buildAgentSourceMaterialFenceKey('user-b')],
      [buildAgentSourceMaterialFenceKey('user-c')],
      [],
    ])
    expect(calls[3]?.sql).toBe('SELECT pg_current_xact_id()::text AS transaction_id')
  })

  it('rejects an empty ID list and empty IDs before issuing a lock query', async () => {
    const { tx, calls } = makeTransaction()

    await expect(acquireSourceMaterialFence(tx, [])).rejects.toThrow(/at least one user ID/i)
    await expect(acquireSourceMaterialFence(tx, [''])).rejects.toThrow(/non-empty string/i)
    await expect(acquireSourceMaterialFence(tx, ['valid-user', ''])).rejects.toThrow(/non-empty string/i)

    expect(calls).toEqual([])
  })

  it('rejects autocommit-style transaction ID changes with a fixed generic error', async () => {
    let transactionSequence = 40
    const { tx, calls } = makeTransaction(async () => [{ transaction_id: String(transactionSequence++) }])

    await expect(acquireSourceMaterialFence(tx, ['private-user-id']))
      .rejects.toThrow(INVALID_FENCE_TRANSACTION)

    expect(calls).toHaveLength(2)
  })

  it('keeps XID mismatch and malformed probe errors generic and without a code', async () => {
    const mismatch = makeTransaction(async callIndex => [{ transaction_id: callIndex === 1 ? '41' : '42' }])
    const mismatchError = await acquireSourceMaterialFence(mismatch.tx, ['private-user-id']).catch(error => error)
    expect(mismatchError).toBeInstanceOf(Error)
    expect(mismatchError).toHaveProperty('message', INVALID_FENCE_TRANSACTION)
    expect(mismatchError).not.toHaveProperty('code')

    const malformed = makeTransaction(async callIndex => (
      callIndex === 1 ? [{ transaction_id: 'not-a-transaction-id' }] : [{ transaction_id: '17' }]
    ))
    const malformedError = await acquireSourceMaterialFence(malformed.tx, ['private-user-id']).catch(error => error)
    expect(malformedError).toBeInstanceOf(Error)
    expect(malformedError).toHaveProperty('message', INVALID_FENCE_TRANSACTION)
    expect(malformedError).not.toHaveProperty('code')
  })

  it('rejects missing or malformed transaction IDs from either probe with the same generic error', async () => {
    const invalidResults: Array<{ callIndex: number; result: unknown }> = [
      { callIndex: 1, result: [] },
      { callIndex: 1, result: [{ transaction_id: 'not-a-transaction-id' }] },
      { callIndex: 2, result: [] },
      { callIndex: 2, result: [{ transaction_id: 'not-a-transaction-id' }] },
    ]

    for (const invalid of invalidResults) {
      const { tx } = makeTransaction(async callIndex => (
        callIndex === invalid.callIndex ? invalid.result : [{ transaction_id: '17' }]
      ))

      await expect(acquireSourceMaterialFence(tx, ['private-user-id']))
        .rejects.toThrow(INVALID_FENCE_TRANSACTION)
    }
  })

  it('wraps query errors without exposing the cause, user ID, or transaction ID', async () => {
    const userId = 'private-user-id'
    const { tx, calls } = makeTransaction(async callIndex => {
      if (callIndex === 2) throw new Error(`query failed for ${userId} at transaction 8675309`)
      return [{ transaction_id: '17' }]
    })

    let caught: unknown
    try {
      await acquireSourceMaterialFence(tx, [userId])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toBe(INVALID_FENCE_TRANSACTION)
    expect(message).not.toContain(userId)
    expect(message).not.toContain('8675309')
    expect(calls).toHaveLength(2)
  })

  it.each([1, 2])('normalizes allowlisted database errors from query %i without retry markers or private details', async failureQueryIndex => {
    for (const testCase of DATABASE_ERROR_CASES) {
      const { tx, calls } = makeTransaction(async callIndex => {
        if (callIndex === failureQueryIndex) throw testCase.error
        return [{ transaction_id: '17' }]
      })
      const error = await acquireSourceMaterialFence(tx, ['private-user-id']).catch(caught => caught)

      expect(error).toBeInstanceOf(Error)
      expect(error).toHaveProperty('message', INVALID_FENCE_TRANSACTION)
      expect(String(error)).not.toContain(SENSITIVE_DATABASE_ERROR)
      expect(JSON.stringify(error)).not.toContain(SENSITIVE_DATABASE_ERROR)
      expect(String(error)).not.toContain('private-user-id')
      expect(String(error)).not.toContain('8675309')
      expect(error).not.toHaveProperty('detail')
      expect(error).not.toHaveProperty('table')
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('retryable')
      expect(error).not.toHaveProperty('shouldRetry')
      expect(error).not.toHaveProperty('retryAfterMs')

      if (testCase.code === undefined) {
        expect(error).not.toHaveProperty('code')
        expect(error).not.toHaveProperty('meta')
        expect(Object.keys(error as object)).toEqual([])
      } else {
        expect(error).toHaveProperty('code', testCase.code)
        if (testCase.metaCode === undefined) {
          expect(error).not.toHaveProperty('meta')
          expect(Object.keys(error as object)).toEqual(['code'])
        } else {
          expect(error).toHaveProperty('meta', { code: testCase.metaCode })
          expect(Object.keys(error as object)).toEqual(['code', 'meta'])
        }
      }
      expect(calls).toHaveLength(failureQueryIndex)
    }
  })
})
