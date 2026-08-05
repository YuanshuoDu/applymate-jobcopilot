import { Prisma } from '@prisma/client'
import type { Prisma as PrismaTypes } from '@prisma/client'
import { db } from '@/lib/db'
import { createAdminAuditData, type AuditInput } from './audit'

export async function runAdminMutation<T>(input: {
  actorUserId: string
  action: string
  idempotencyKey: string
  targetId?: string
  audit: Omit<AuditInput, 'actorUserId' | 'action'>
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
    await tx.adminAuditLog.create({
      data: createAdminAuditData({
        ...input.audit,
        actorUserId: input.actorUserId,
        action: input.action,
      }),
    })
    return { duplicate: false as const, value }
  })
}
