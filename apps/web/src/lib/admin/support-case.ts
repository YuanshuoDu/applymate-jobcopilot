import type { Prisma, SupportCasePriority, SupportCaseStatus } from '@prisma/client'
import type { AdminActor } from './authorization'

const statuses = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'] as const
const priorities = ['low', 'normal', 'high', 'urgent'] as const

/** Support staff can work only their own queue or an unassigned case. */
export function supportCaseScope(actor: Pick<AdminActor, 'roleKey' | 'userId'>): Prisma.SupportCaseWhereInput {
  return actor.roleKey === 'support'
    ? { OR: [{ assignedAdminId: null }, { assignedAdminId: actor.userId }] }
    : {}
}

export function parseSupportCaseUpdate(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const status = typeof input.status === 'string' && statuses.includes(input.status as (typeof statuses)[number]) ? input.status : undefined
  const priority = typeof input.priority === 'string' && priorities.includes(input.priority as (typeof priorities)[number]) ? input.priority : undefined
  const assignedAdminId = input.assignedAdminId === null || typeof input.assignedAdminId === 'string' && input.assignedAdminId.length <= 64 ? input.assignedAdminId : undefined
  const version = typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0 ? input.version : null
  if (!version || (!status && !priority && assignedAdminId === undefined)) return null
  return { status: status as SupportCaseStatus | undefined, priority: priority as SupportCasePriority | undefined, assignedAdminId, version }
}
