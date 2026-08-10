import type { Plan } from '@prisma/client'

const planRank: Record<Plan, number> = { free: 0, pro: 1, enterprise: 2 }

export function classifyPlanChange(from: Plan, to: Plan): 'same' | 'upgrade' | 'downgrade' {
  if (from === to) return 'same'
  return planRank[to] > planRank[from] ? 'upgrade' : 'downgrade'
}

export function shouldScheduleDowngrade(input: { from: Plan; to: Plan; currentPeriodEnd: Date | null; now?: Date; applyImmediately?: boolean }): boolean {
  if (input.applyImmediately || classifyPlanChange(input.from, input.to) !== 'downgrade') return false
  return Boolean(input.currentPeriodEnd && input.currentPeriodEnd > (input.now ?? new Date()))
}
