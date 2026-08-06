import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { toAdminUserDto } from '@/lib/admin/dto'
import { planKey } from '@/lib/admin/plans'
import { adminError, adminJson, requestId } from '@/lib/admin/route-utils'

const USER_SELECT = {
  id: true, email: true, name: true, plan: true, accountStatus: true, location: true,
  createdAt: true, updatedAt: true, suspendedAt: true,
  _count: { select: { resumes: true, jobs: true, applicationTasks: true } },
} as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdmin('users.read', request)
    const url = new URL(request.url)
    const limit = boundedLimit(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')?.trim() || undefined
    const q = url.searchParams.get('q')?.trim()
    const plan = parsePlan(url.searchParams.get('plan'))
    const accountStatus = parseAccountStatus(url.searchParams.get('status'))
    const users = await db.user.findMany({
      where: {
        ...(plan ? { plan } : {}),
        ...(accountStatus ? { accountStatus } : {}),
        ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit,
      select: USER_SELECT,
    })
    return adminJson({ items: users.map(toAdminUserDto), nextCursor: users.length === limit ? users[users.length - 1]?.id ?? null : null }, 200, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}

function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 50)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50
}

function parsePlan(value: string | null) {
  if (!value) return undefined
  try { return planKey(value) } catch { return undefined }
}

function parseAccountStatus(value: string | null): 'active' | 'suspended' | undefined {
  return value === 'active' || value === 'suspended' ? value : undefined
}
