import { NextRequest, NextResponse } from 'next/server'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { getAgentTaskHistoryMemoryConsent, setAgentTaskHistoryMemoryConsent } from '@/lib/agent-task-history-memory-consent'

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function internalError() {
  return privateNoStore(NextResponse.json({ error: 'internal_error' }, { status: 500 }))
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req)
    if (isErrorResponse(auth)) return privateNoStore(auth)

    const consent = await getAgentTaskHistoryMemoryConsent(auth.userId)
    if (!consent) return privateNoStore(err('user_not_found', 404))
    return privateNoStore(ok(consent))
  } catch {
    return internalError()
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req)
    if (isErrorResponse(auth)) return privateNoStore(auth)

    const body: unknown = await req.json().catch(() => null)
    if (!isConsentMutation(body)) return privateNoStore(err('invalid_agent_task_history_memory_consent', 400))

    const result = await setAgentTaskHistoryMemoryConsent(auth.userId, body)
    if (result.kind === 'not_found') return privateNoStore(err('user_not_found', 404))
    if (result.kind === 'stale') {
      return privateNoStore(NextResponse.json({ error: 'VERSION_CONFLICT', ...result.consent }, { status: 409 }))
    }
    if (result.kind === 'version_exhausted') {
      return privateNoStore(NextResponse.json({ error: 'VERSION_EXHAUSTED', ...result.consent }, { status: 409 }))
    }
    return privateNoStore(ok(result.consent))
  } catch {
    return internalError()
  }
}

function isConsentMutation(value: unknown): value is { enabled: boolean; expectedVersion: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return keys.length === 2 && keys[0] === 'enabled' && keys[1] === 'expectedVersion' &&
    typeof record.enabled === 'boolean' && Number.isSafeInteger(record.expectedVersion) &&
    (record.expectedVersion as number) >= 0 && (record.expectedVersion as number) <= 2_147_483_647
}
