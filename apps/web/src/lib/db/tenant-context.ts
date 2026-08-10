import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { configureTenantTransaction, validateTenantUserId } from './tenant-store'

export function withTenantContext<T>(userId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  validateTenantUserId(userId)
  return db.$transaction(async (tx) => {
    await configureTenantTransaction(tx, userId)
    return callback(tx)
  })
}
