import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'

import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import { readObjectiveSourceToolReceipts } from '@/lib/agent/session/objective-source-tool-receipts'
import { OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION,
  type ObjectiveSourceToolReceiptEvidence } from '@/lib/agent/session/objective-source-tool-receipts-contract'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; itemId: string; sourceKey: string }> }

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateResponse(auth)
  const { id: sessionId, itemId, sourceKey } = await context.params
  const graphRevision = requestedRevision(request)
  if (!validId(sessionId) || !validId(itemId) || !/^src_[A-Za-z0-9_-]{43}$/.test(sourceKey) || graphRevision === undefined) return unavailable()
  let evidence: ObjectiveSourceToolReceiptEvidence | undefined
  try {
    evidence = await runWithTenantContext(auth.userId, () => db.$transaction(tx => readObjectiveSourceToolReceipts(tx, {
      userId: auth.userId, sessionId, finalItemId: itemId, sourceKey, graphRevision,
    }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }))
  } catch { return unavailable() }
  return evidence ? privateResponse(ok({ toolReceiptEvidence: evidence })) : unavailable()
}

function requestedRevision(request: NextRequest): number | undefined {
  const entries = [...new URL(request.url).searchParams.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'graphRevision' || !/^[1-9]\d{0,5}$/.test(entries[0][1] ?? '')) return undefined
  const value = Number(entries[0][1])
  return Number.isSafeInteger(value) && value > 0 && value <= OBJECTIVE_SOURCE_TOOL_RECEIPT_MAX_GRAPH_REVISION ? value : undefined
}
function unavailable(): Response {
  return privateResponse(Response.json({ error: { code: 'objective_tool_receipts_unavailable',
    message: 'Objective tool receipts are unavailable.', details: {} } }, { status: 404 }))
}
function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
