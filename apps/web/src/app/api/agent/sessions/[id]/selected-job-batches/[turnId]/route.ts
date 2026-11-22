import { NextRequest } from 'next/server'

import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import { readSelectedJobBatchWorkbenchModel } from '@/lib/agent/session/selected-job-batch-workbench-read-model'

type RouteContext = Readonly<{ params: Promise<{ id: string; turnId: string }> }>

function privateNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

function notFound(): Response {
  return Response.json({ error: { code: 'selected_job_batch_not_found', message: 'Selected Job batch not found', details: {} } }, { status: 404 })
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateNoStore(auth)
  const { id: sessionId, turnId } = await context.params
  try {
    return await runWithTenantContext(auth.userId, async () => {
      const model = await readSelectedJobBatchWorkbenchModel(db, { userId: auth.userId, sessionId, turnId })
      return privateNoStore(model ? ok(model) : notFound())
    })
  } catch {
    return privateNoStore(Response.json({ error: { code: 'selected_job_batch_unavailable', message: 'Selected Job batch is unavailable', details: {} } }, { status: 500 }))
  }
}
