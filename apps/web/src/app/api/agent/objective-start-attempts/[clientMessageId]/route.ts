import { NextRequest, NextResponse } from "next/server"

import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { getObjectiveStartAttempt, isValidAttemptKey } from "@/lib/agent/control-plane/commands/objective-start-attempt-ledger"
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

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)

  const accountScope = taskRecoveryAccountScope(auth.userId)
  if (request.headers.get("x-expected-account-scope") !== accountScope) {
    return scopedJson(accountScope, { error: "Task recovery account scope changed", accountScope }, 409)
  }
  const { clientMessageId } = await context.params
  if (!isValidAttemptKey(clientMessageId)) return scopedJson(accountScope, { error: "Invalid objective start attempt key" }, 422)

  try {
    return scopedJson(accountScope, { accountScope, ...(await getObjectiveStartAttempt(db, auth.userId, clientMessageId)) })
  } catch {
    return scopedJson(accountScope, { error: "Could not read objective start recovery state" }, 500)
  }
}
