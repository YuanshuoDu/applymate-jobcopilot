import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function withTenantContext<T>(userId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid tenant user id')
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`
    return callback(tx)
  })
}
