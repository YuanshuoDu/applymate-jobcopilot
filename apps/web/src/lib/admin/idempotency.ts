import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export async function claimAdminIdempotencyKey(actorUserId: string, action: string, key: string, targetId?: string) {
  try {
    await db.adminIdempotencyKey.create({ data: { actorUserId, action, idempotencyKey: key, targetId } })
    return true
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
    throw error
  }
}
