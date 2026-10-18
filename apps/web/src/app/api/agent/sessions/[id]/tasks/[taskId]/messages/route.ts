import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { readJsonBody, isResponse } from "../../../../command-route-helpers"
import { TaskMessageError, TaskMessageService } from "@/lib/agent/control-plane/commands/task-message-service"

interface RouteContext { params: Promise<{ id: string; taskId: string }> }
type MessageBody = { clientMessageId: string; text: string; expectedAttemptCount?: number }

function invalid(message: string): NextResponse {
  return NextResponse.json({ error: { code: "invalid_task_follow_up", message, details: {} } }, { status: 422 })
}

function parseBody(body: unknown, request: Request): MessageBody | NextResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Invalid task follow-up request")
  const row = body as Record<string, unknown>
  if (Object.keys(row).some(key => !["clientMessageId", "text", "expectedAttemptCount"].includes(key))) {
    return invalid("Unsupported task follow-up field")
  }
  const clientMessageId = typeof row.clientMessageId === "string" ? row.clientMessageId.trim() : ""
  const text = typeof row.text === "string" ? row.text.trim() : ""
  const header = request.headers.get("idempotency-key")?.trim() || null
  if (!clientMessageId || clientMessageId.length > 128 || !text || text.length > 20_000
    || (row.expectedAttemptCount !== undefined && (!Number.isSafeInteger(row.expectedAttemptCount) || (row.expectedAttemptCount as number) < 1))
    || (header !== null && (header.length > 128 || header !== clientMessageId))) {
    return invalid("A message, client message ID, and valid expected attempt are required")
  }
  return {
    clientMessageId,
    text,
    ...(row.expectedAttemptCount !== undefined ? { expectedAttemptCount: row.expectedAttemptCount as number } : {}),
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, taskId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const parsed = parseBody(body, request)
  if (parsed instanceof NextResponse) return parsed
  try {
    const result = await new TaskMessageService(db).send({ sessionId, taskId, userId: auth.userId, ...parsed })
    return NextResponse.json(result, { status: result.disposition === "duplicate" ? 200 : 202 })
  } catch (error: unknown) {
    if (error instanceof TaskMessageError) {
      return NextResponse.json({ error: { code: error.code, message: error.message, details: {} } }, { status: error.status })
    }
    return NextResponse.json({ error: { code: "internal_error", message: "Could not send the task follow-up", details: {} } }, { status: 500 })
  }
}
