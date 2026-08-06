import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { toAdminMemberDto } from '@/lib/admin/dto'
import { adminError, adminJson, requestId } from '@/lib/admin/route-utils'

const MEMBER_SELECT = {
  id: true, userId: true, status: true, mfaLevel: true, sessionVersion: true, grantedAt: true,
  role: { select: { key: true, name: true, permissions: true } },
  user: { select: { id: true, email: true, name: true, plan: true } },
} as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdmin('admin_members.read', request)
    const url = new URL(request.url)
    const limit = boundedLimit(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')?.trim() || undefined
    const status = parseStatus(url.searchParams.get('status'))
    const search = url.searchParams.get('q')?.trim()
    const items = await db.adminMembership.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(search ? { user: { OR: [{ email: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } } : {}),
      },
      orderBy: { grantedAt: 'desc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit,
      select: MEMBER_SELECT,
    })
    return adminJson({ items: items.map(toAdminMemberDto), nextCursor: items.length === limit ? items[items.length - 1]?.id ?? null : null }, 200, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}

function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 50)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50
}

function parseStatus(value: string | null): 'active' | 'suspended' | 'revoked' | undefined {
  return value === 'active' || value === 'suspended' || value === 'revoked' ? value : undefined
}
