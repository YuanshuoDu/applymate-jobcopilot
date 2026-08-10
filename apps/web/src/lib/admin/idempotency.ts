import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export class AdminIdempotencyError extends Error {
  readonly status = 409
  readonly code = 'IDEMPOTENCY_KEY_REUSED'
  constructor() { super('Idempotency-Key was already used for a different request') }
}

interface TransactionDatabase<T> {
  $transaction<R>(callback: (transaction: T) => Promise<R>): Promise<R>
}

interface IdempotencyInput {
  actorUserId: string
  key: string
  action: string
  body: unknown
}

interface IdempotencyResponse {
  status: number
  body: unknown
}

interface IdempotencyStore {
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown>
  create(args: { data: Record<string, unknown> }): Promise<unknown>
}

export async function withAdminIdempotency<T>(
  database: TransactionDatabase<T>,
  input: IdempotencyInput,
  operation: (transaction: T) => Promise<IdempotencyResponse>,
): Promise<IdempotencyResponse & { replayed: boolean }> {
  return database.$transaction(async transaction => {
    const store = (transaction as unknown as { adminIdempotencyKey: IdempotencyStore }).adminIdempotencyKey
    const requestHash = hashBody(input.body)
    let existing: unknown = null
    let legacy = false
    try {
      existing = await store.findUnique({ where: { actorUserId_key: { actorUserId: input.actorUserId, key: input.key } } })
      legacy = true
    } catch {
      existing = await store.findUnique({ where: { actorUserId_action_idempotencyKey: { actorUserId: input.actorUserId, action: input.action, idempotencyKey: input.key } } })
    }
    if (existing) {
      if (legacy) {
        const row = existing as { requestHash?: unknown; responseStatus?: unknown; responseBody?: unknown }
        if (row.requestHash !== requestHash) throw new AdminIdempotencyError()
        return { status: typeof row.responseStatus === 'number' ? row.responseStatus : 200, body: row.responseBody, replayed: true }
      }
      return { status: 200, body: { duplicate: true }, replayed: true }
    }
    const result = await operation(transaction)
    if (legacy) {
      await store.create({ data: { actorUserId: input.actorUserId, key: input.key, action: input.action, requestHash, responseStatus: result.status, responseBody: result.body } })
    } else {
      await store.create({ data: { actorUserId: input.actorUserId, action: input.action, idempotencyKey: input.key } })
    }
    return { ...result, replayed: false }
  })
}

function hashBody(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export async function claimAdminIdempotencyKey(actorUserId: string, action: string, key: string, targetId?: string) {
  try {
    await db.adminIdempotencyKey.create({ data: { actorUserId, action, idempotencyKey: key, targetId } })
    return true
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
    throw error
  }
}
