import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { toAdminUserDto } from '@/lib/admin/dto'
import { adminError, adminJson, requestId } from '@/lib/admin/route-utils'

const USER_DETAIL_SELECT = {
  id: true, email: true, name: true, plan: true, accountStatus: true, location: true,
  createdAt: true, updatedAt: true, suspendedAt: true,
  _count: { select: { resumes: true, jobs: true, applicationTasks: true } },
  planChanges: { orderBy: { createdAt: 'desc' as const }, take: 20, select: { id: true, fromPlan: true, toPlan: true, createdAt: true } },
} as const

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    await requireAdmin('users.read', request)
    const { id } = await context.params
    const user = await db.user.findUnique({ where: { id }, select: USER_DETAIL_SELECT })
    if (!user) return adminJson({ error: 'ADMIN_USER_NOT_FOUND' }, 404, correlationId)
    const { planChanges, ...metadata } = user
    return adminJson({ user: toAdminUserDto(metadata), planChanges: planChanges.map(change => ({ id: change.id, fromPlan: change.fromPlan, toPlan: change.toPlan, createdAt: change.createdAt.toISOString() })) }, 200, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}
