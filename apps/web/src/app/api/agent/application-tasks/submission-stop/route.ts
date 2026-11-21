import { NextRequest, NextResponse } from "next/server"

import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { isResponse, readJsonBody } from "../../sessions/command-route-helpers"
import {
  ApplicationSubmissionStopError,
  requestApplicationSubmissionStopInTransaction,
  type ApplicationSubmissionStopOutcome,
} from "../submission-stop"

const REQUEST_KEYS = ["applicationTaskId", "expectedAttemptTarget", "sessionId"] as const
type StopRequest = Readonly<{ applicationTaskId: string; expectedAttemptTarget: string; sessionId: string }>

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function json(value: unknown, status = 200): NextResponse {
  return noStore(NextResponse.json(value, { status }))
}

function invalidRequest(): NextResponse {
  return json({ error: { code: "invalid_submission_stop_request", message: "Invalid submission Stop request", details: {} } }, 422)
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

function parseStopRequest(value: unknown): StopRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const row = value as Record<string, unknown>, keys = Object.keys(row).sort()
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, index) => key !== REQUEST_KEYS[index])) return null
  return validId(row.applicationTaskId) && validId(row.sessionId)
    && typeof row.expectedAttemptTarget === "string" && /^ast1_[a-f0-9]{64}$/.test(row.expectedAttemptTarget)
    ? { applicationTaskId: row.applicationTaskId, expectedAttemptTarget: row.expectedAttemptTarget, sessionId: row.sessionId }
    : null
}

function isOutcome(value: unknown): value is ApplicationSubmissionStopOutcome {
  return value === "stop_requested" || value === "too_late" || value === "submitted" || value === "uncertain"
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)
  if (new URL(request.url).searchParams.size > 0) return invalidRequest()
  let body: unknown
  try { body = await readJsonBody(request) } catch { return invalidRequest() }
  if (isResponse(body)) return noStore(body)
  const input = parseStopRequest(body)
  if (!input) return invalidRequest()

  try {
    const outcome = await db.$transaction(async tx => {
      const result = await requestApplicationSubmissionStopInTransaction(tx, { ...input, userId: auth.userId })
      if (!isOutcome(result)) throw new Error("Invalid Stop outcome")
      return result
    })
    return json({ outcome })
  } catch (error: unknown) {
    return json({ outcome: "uncertain" }, error instanceof ApplicationSubmissionStopError ? 409 : 503)
  }
}
