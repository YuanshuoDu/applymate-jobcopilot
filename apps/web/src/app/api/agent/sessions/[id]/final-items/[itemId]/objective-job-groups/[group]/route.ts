import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'

import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import { readObjectiveJobEvidence } from '@/lib/agent/session/objective-job-evidence'
import { OBJECTIVE_JOB_EVIDENCE_GROUPS, type ObjectiveJobEvidenceGroup } from '@/lib/agent/session/objective-job-evidence-contract'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; itemId: string; group: string }> }

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateResponse(auth)
  const { id: sessionId, itemId, group } = await context.params
  const graphRevision = requestedRevision(request)
  if (!validId(sessionId) || !validId(itemId) || !groupOf(group) || graphRevision === undefined) return unavailable()
  const jobEvidence = await runWithTenantContext(auth.userId, () => db.$transaction(tx => readObjectiveJobEvidence(tx, {
    userId: auth.userId, sessionId, finalItemId: itemId, graphRevision, group,
  }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }))
  return jobEvidence ? privateResponse(ok({ jobEvidence })) : unavailable()
}

function groupOf(value: string): value is ObjectiveJobEvidenceGroup {
  return OBJECTIVE_JOB_EVIDENCE_GROUPS.includes(value as ObjectiveJobEvidenceGroup)
}
function requestedRevision(request: NextRequest): number | undefined {
  const params = new URL(request.url).searchParams, entries = [...params.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'graphRevision' || !/^[1-9]\d{0,8}$/.test(entries[0][1] ?? '')) return undefined
  const value = Number(entries[0][1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
function unavailable(): Response {
  return privateResponse(Response.json({ error: { code: 'objective_job_evidence_unavailable', message: 'Objective Job evidence is unavailable.', details: {} } }, { status: 404 }))
}
function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
