import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok } from '@/lib/api-helpers'
import { requireSettingsAdmin, toAdminSettingsDto } from '@/lib/admin/settings-access'

function adminOk<T>(data: T, status = 200) {
  const response = ok(data, status)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', crypto.randomUUID())
  return response
}

export async function GET(req: NextRequest) {
  const actor = await requireSettingsAdmin(req)
  if (isErrorResponse(actor)) return actor

  const url = new URL(req.url)
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
  const parsedLimit = Number(url.searchParams.get('limit') ?? 50)
  const take = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 100) : 50
  const parsedPage = Number(url.searchParams.get('page') ?? 1)
  const page = Number.isFinite(parsedPage) ? Math.max(Math.trunc(parsedPage), 1) : 1
  const where: Prisma.UserWhereInput | undefined = query ? {
      OR: [
        { email: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
      ],
    } : undefined
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * take,
      take,
      select: {
        id: true, email: true, name: true, plan: true,
        phone: true, location: true, linkedin: true, github: true,
        createdAt: true, onboardedAt: true,
        preferences: true,
        apiKeys: { select: { adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true } },
        accounts: { select: { provider: true, scope: true } },
      },
    }),
  ])

  return adminOk({
    users: users.map(user => toAdminSettingsDto(user as Record<string, unknown>)),
    total: Number(total),
    page,
    pageSize: take,
  })
}
