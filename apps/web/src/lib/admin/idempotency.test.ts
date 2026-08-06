import { describe, expect, it } from 'vitest'
import { withAdminIdempotency } from './idempotency'

type Row = {
  actorUserId: string
  key: string
  requestHash: string
  responseStatus: number
  responseBody: unknown
}

function fakeDatabase() {
  const rows = new Map<string, Row>()
  return {
    rows,
    async $transaction<T>(callback: (tx: { adminIdempotencyKey: { findUnique: Function; create: Function } }) => Promise<T>) {
      return callback({
        adminIdempotencyKey: {
          findUnique: async ({ where }: { where: { actorUserId_key: { actorUserId: string; key: string } } }) =>
            rows.get(`${where.actorUserId_key.actorUserId}:${where.actorUserId_key.key}`) ?? null,
          create: async ({ data }: { data: Row }) => {
            rows.set(`${data.actorUserId}:${data.key}`, data)
            return data
          },
        },
      })
    },
  }
}

describe('withAdminIdempotency', () => {
  it('stores one response and replays it without executing twice', async () => {
    const database = fakeDatabase()
    let executions = 0
    const input = { actorUserId: 'admin_1', key: 'request_1', action: 'role.update', body: { version: 1 } }

    const first = await withAdminIdempotency(database, input, async () => {
      executions += 1
      return { status: 200, body: { id: 'role_1' } }
    })
    const second = await withAdminIdempotency(database, input, async () => {
      executions += 1
      return { status: 200, body: { id: 'role_1' } }
    })

    expect(first).toEqual({ status: 200, body: { id: 'role_1' }, replayed: false })
    expect(second).toEqual({ status: 200, body: { id: 'role_1' }, replayed: true })
    expect(executions).toBe(1)
  })

  it('rejects reusing a key for a different request body', async () => {
    const database = fakeDatabase()
    const input = { actorUserId: 'admin_1', key: 'request_1', action: 'role.update', body: { version: 1 } }
    await withAdminIdempotency(database, input, async () => ({ status: 200, body: { id: 'role_1' } }))

    await expect(withAdminIdempotency(database, { ...input, body: { version: 2 } }, async () => ({ status: 200, body: {} })))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })
})
