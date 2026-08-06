import { createHash } from 'node:crypto'

interface StoredKey {
  requestHash: string
  responseStatus: number
  responseBody: unknown
}

export interface IdempotencyStore {
  findUnique(args: {
    where: { actorUserId_key: { actorUserId: string; key: string } }
  }): Promise<StoredKey | null>
  create(args: {
    data: {
      actorUserId: string
      key: string
      action: string
      requestHash: string
      responseStatus: number
      responseBody: unknown
    }
  }): Promise<unknown>
}

export interface IdempotencyTransaction {
  adminIdempotencyKey: IdempotencyStore
}

interface TransactionDatabase<T extends IdempotencyTransaction> {
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

export class AdminIdempotencyError extends Error {
  readonly status = 409
  readonly code = 'IDEMPOTENCY_KEY_REUSED'

  constructor() {
    super('Idempotency-Key was already used for a different request')
  }
}

export async function withAdminIdempotency(
  database: TransactionDatabase<IdempotencyTransaction>,
  input: IdempotencyInput,
  operation: (transaction: IdempotencyTransaction) => Promise<IdempotencyResponse>,
): Promise<IdempotencyResponse & { replayed: boolean }> {
  const requestHash = hashBody(input.body)
  return database.$transaction(async transaction => {
    const existing = await transaction.adminIdempotencyKey.findUnique({
      where: { actorUserId_key: { actorUserId: input.actorUserId, key: input.key } },
    })

    if (existing) {
      if (existing.requestHash !== requestHash) throw new AdminIdempotencyError()
      return { status: existing.responseStatus, body: existing.responseBody, replayed: true }
    }

    const result = await operation(transaction)
    await transaction.adminIdempotencyKey.create({
      data: {
        actorUserId: input.actorUserId,
        key: input.key,
        action: input.action,
        requestHash,
        responseStatus: result.status,
        responseBody: result.body,
      },
    })
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
