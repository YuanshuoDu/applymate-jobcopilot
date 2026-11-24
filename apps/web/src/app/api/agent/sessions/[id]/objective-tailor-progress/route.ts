import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import { readObjectiveTailorProgress } from '@/lib/agent/session/objective-tailor-progress'

interface RouteContext { params: Promise<{ id: string }> }
const SELECTORS = ['graphItemId', 'turnId', 'rootTaskId', 'revision'] as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function invalidQuery(): Response {
  return noStore(NextResponse.json({ error: { code: 'invalid_objective_tailor_progress_query',
    message: 'Objective progress selectors must be supplied once as a complete set', details: {} } }, { status: 400 }))
}

function parseSelectors(request: Request, sessionId: string) {
  if (!ID.test(sessionId)) return null
  const params = new URL(request.url).searchParams
  if ([...params.keys()].some(key => !SELECTORS.includes(key as typeof SELECTORS[number]))) return null
  const values = SELECTORS.map(name => params.getAll(name))
  if (values.some(entries => entries.length !== 1 || !entries[0])) return null
  const [graphItemId, turnId, rootTaskId, revisionText] = values.map(entries => entries[0]!)
  const revision = Number(revisionText)
  if (![graphItemId, turnId, rootTaskId].every(value => ID.test(value)) || !Number.isSafeInteger(revision)
    || revision < 1 || String(revision) !== revisionText) return null
  return { sessionId, graphItemId, turnId, rootTaskId, revision }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)
  const { id: sessionId } = await context.params
  const selectors = parseSelectors(request, sessionId)
  if (!selectors) return invalidQuery()
  try {
    return await runWithTenantContext(auth.userId, async () => noStore(ok({ progress: await readObjectiveTailorProgress(db, {
      userId: auth.userId, ...selectors,
    }) })))
  } catch {
    return noStore(NextResponse.json({ error: { code: 'objective_tailor_progress_unavailable',
      message: 'Objective progress is unavailable', details: {} } }, { status: 500 }))
  }
}
