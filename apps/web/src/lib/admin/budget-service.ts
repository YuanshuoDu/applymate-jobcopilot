import { db } from '@/lib/db'

export function parseBudgetLimit(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null
}

export async function updateBudgetLimit(input: { userId: string; month: string; limit: number; version: number; actorUserId: string; reason: string; idempotencyKey: string }) {
  return db.$transaction(async (tx) => {
    const budget = await tx.aiBudget.findUnique({ where: { userId_month: { userId: input.userId, month: input.month } }, select: { id: true, used: true, limit: true, version: true } })
    if (!budget || budget.version !== input.version) return null
    const updated = await tx.aiBudget.updateMany({ where: { id: budget.id, version: input.version }, data: { limit: input.limit, version: { increment: 1 } } })
    if (!updated.count) return null
    await tx.aiBudgetAdjustment.create({ data: { budgetId: budget.id, actorUserId: input.actorUserId, kind: 'limit_override', previousLimit: budget.limit, nextLimit: input.limit, reason: input.reason, idempotencyKey: input.idempotencyKey } })
    return { used: budget.used, limit: input.limit, version: budget.version + 1 }
  })
}
