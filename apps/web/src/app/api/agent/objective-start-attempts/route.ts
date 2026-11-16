import { NextRequest } from "next/server"

import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { listObjectiveStartAttempts } from "@/lib/agent/control-plane/commands/objective-start-attempt-ledger"

const MAX_ATTEMPTS = 20

function readLimit(request: NextRequest): number | null {
  const value = request.nextUrl.searchParams.get("limit")
  if (value === null) return MAX_ATTEMPTS
  if (!/^[0-9]{1,2}$/.test(value)) return null
  const limit = Number(value)
  return limit >= 1 && limit <= MAX_ATTEMPTS ? limit : null
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const limit = readLimit(request)
  if (limit === null) return err(`limit must be between 1 and ${MAX_ATTEMPTS}`, 400)
  const result = await listObjectiveStartAttempts(db, auth.userId, limit)
  const response = ok(result)
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-Account-Scope", result.accountScope)
  return response
}
