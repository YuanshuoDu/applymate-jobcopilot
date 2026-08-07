import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export function parseBudgetLimit(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null
}

export type BudgetLimitInput = { userId: string; month: string; limit: number; version: number; actorUserId: string; reason: string; idempotencyKey: string }

export async function updateBudgetLimitInTransaction(tx: Prisma.TransactionClient, input: BudgetLimitInput) {
  const budget = await tx.aiBudget.findUnique({ where: { userId_month: { userId: input.userId, month: input.month } }, select: { id: true, used: true, limit: true, version: true } })
  if (!budget || budget.version !== input.version) return null
  const updated = await tx.aiBudget.updateMany({ where: { id: budget.id, version: input.version }, data: { limit: input.limit, version: { increment: 1 } } })
  if (!updated.count) return null
  await tx.aiBudgetAdjustment.create({ data: { budgetId: budget.id, actorUserId: input.actorUserId, kind: 'limit_override', previousLimit: budget.limit, nextLimit: input.limit, reason: input.reason, idempotencyKey: input.idempotencyKey } })
  return { used: budget.used, limit: input.limit, version: budget.version + 1 }
}

export type BudgetResetApprovalInput = { requestId: string; approverId: string; idempotencyKey: string }

export async function approveBudgetResetInTransaction(tx: Prisma.TransactionClient, input: BudgetResetApprovalInput) {
  const request = await tx.aiBudgetResetRequest.findUnique({ where: { id: input.requestId }, select: { id: true, requesterId: true, status: true, expiresAt: true, budgetVersion: true, budget: { select: { id: true, used: true, limit: true, version: true } } } })
  if (!request || request.requesterId === input.approverId || request.status !== 'pending' || request.expiresAt <= new Date() || request.budget.version !== request.budgetVersion) return null
  const updated = await tx.aiBudget.updateMany({ where: { id: request.budget.id, version: request.budgetVersion }, data: { used: 0, version: { increment: 1 } } })
  if (!updated.count) return null
  await tx.aiBudgetAdjustment.create({ data: { budgetId: request.budget.id, actorUserId: input.approverId, kind: 'usage_reset', previousLimit: request.budget.limit, nextLimit: request.budget.limit, previousUsed: request.budget.used, nextUsed: 0, reason: 'Approved budget usage reset', idempotencyKey: input.idempotencyKey } })
  const approved = await tx.aiBudgetResetRequest.updateMany({ where: { id: request.id, status: 'pending', approverId: null }, data: { status: 'approved', approverId: input.approverId, approvedAt: new Date(), approveIdempotencyKey: input.idempotencyKey } })
  return approved.count ? { budgetId: request.budget.id, version: request.budgetVersion + 1, previousUsed: request.budget.used } : null
}

export async function updateBudgetLimit(input: BudgetLimitInput) {
  return db.$transaction((tx) => updateBudgetLimitInTransaction(tx, input))
}

export async function approveBudgetReset(input: BudgetResetApprovalInput) {
  return db.$transaction((tx) => approveBudgetResetInTransaction(tx, input))
}
