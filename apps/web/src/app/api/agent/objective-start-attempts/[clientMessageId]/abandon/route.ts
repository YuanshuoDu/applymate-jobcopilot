import { NextRequest, NextResponse } from "next/server"

import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { abandonObjectiveStartAttempt, isValidAttemptKey } from "@/lib/agent/control-plane/commands/objective-start-attempt-ledger"
import { taskRecoveryAccountScope } from "@/lib/agent/control-plane/commands/objective-start-attempt-read-model"

interface RouteContext {
  params: Promise<{ clientMessageId: string }>
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function json(data: unknown, status = 200): NextResponse {
  return noStore(NextResponse.json(data, { status }))
}

function scopedJson(accountScope: string, data: unknown, status = 200): NextResponse {
  const response = json(data, status)
  response.headers.set("X-Account-Scope", accountScope)
  return response
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && (!/^[0-9]{1,8}$/.test(declaredLength) || Number(declaredLength) > 0)) return false
  if (!request.body) return true
  const reader = request.body.getReader()
  try {
    for (let chunks = 0; chunks < 2; chunks += 1) {
      const item = await reader.read()
      if (item.done) return true
      if ((item.value?.byteLength ?? 0) > 0) return false
    }
    return false
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)

  const accountScope = taskRecoveryAccountScope(auth.userId)
  if (request.headers.get("x-expected-account-scope") !== accountScope) {
    return scopedJson(accountScope, { error: "Task recovery account scope changed", accountScope }, 409)
  }
  const { clientMessageId } = await context.params
  if (!isValidAttemptKey(clientMessageId) || !(await hasEmptyBody(request))) {
    return scopedJson(accountScope, { error: "Invalid objective start attempt abandonment request" }, 422)
  }

  try {
    // An accepted receipt means the server won the race; this endpoint never cancels accepted work.
    return scopedJson(accountScope, { accountScope, ...(await abandonObjectiveStartAttempt(db, auth.userId, clientMessageId)) })
  } catch {
    return scopedJson(accountScope, { error: "Could not abandon objective start attempt" }, 500)
  }
}
