import { Prisma } from '@prisma/client'
import type { Prisma as PrismaTypes } from '@prisma/client'
import { db } from '@/lib/db'
import { createAdminAuditData, type AuditInput } from './audit'

export class AdminMutationConflict extends Error {
  constructor(message = 'The requested admin mutation could not be applied') {
    super(message)
    this.name = 'AdminMutationConflict'
  }
}

export async function runAdminMutation<T>(input: {
  actorUserId: string
  action: string
  idempotencyKey: string
  targetId?: string
  audit: Omit<AuditInput, 'actorUserId' | 'action'> | ((value: T) => Omit<AuditInput, 'actorUserId' | 'action'>)
  mutate: (tx: PrismaTypes.TransactionClient) => Promise<T>
}) {
  return db.$transaction(async (tx) => {
    try {
      await tx.adminIdempotencyKey.create({
        data: {
          actorUserId: input.actorUserId,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          targetId: input.targetId,
        },
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { duplicate: true as const }
      throw error
    }

    const value = await input.mutate(tx)
    const audit = typeof input.audit === 'function' ? input.audit(value) : input.audit
    await tx.adminAuditLog.create({
      data: createAdminAuditData({
        ...audit,
        actorUserId: input.actorUserId,
        action: input.action,
      }),
    })
    return { duplicate: false as const, value }
  })
}
