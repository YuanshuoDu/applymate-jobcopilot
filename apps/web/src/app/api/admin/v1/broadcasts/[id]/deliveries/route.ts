import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { db } from '@/lib/db'

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.create', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const deliveries = await db.adminBroadcastDelivery.findMany({ where: { broadcastId: id }, orderBy: { updatedAt: 'desc' }, take: 500, select: { id: true, userId: true, status: true, attempts: true, error: true, deliveredAt: true, createdAt: true, updatedAt: true } })
  return NextResponse.json({ deliveries }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
