import { NextRequest, NextResponse } from "next/server"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { readJsonBody, isResponse } from "../../../../command-route-helpers"
import { TaskInterruptError, TaskInterruptService } from "@/lib/agent/control-plane/commands/task-interrupt-service"

interface RouteContext { params: Promise<{ id: string; taskId: string }> }

function parseRequestKey(body: unknown, request: Request): string | NextResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: { code: "invalid_task_interrupt", message: "Invalid task interrupt request", details: {} } }, { status: 422 })
  }
  const row = body as Record<string, unknown>
  if (Object.keys(row).some(key => !["clientMessageId", "schemaVersion"].includes(key))) {
    return NextResponse.json({ error: { code: "invalid_task_interrupt", message: "Unsupported task interrupt field", details: {} } }, { status: 422 })
  }
  const bodyKey = row.clientMessageId === undefined ? null : typeof row.clientMessageId === "string" ? row.clientMessageId.trim() : ""
  const header = request.headers.get("idempotency-key")?.trim() || null
  const key = bodyKey || header
  if ((row.schemaVersion !== undefined && row.schemaVersion !== schemaVersion)
    || (row.clientMessageId !== undefined && (!bodyKey || bodyKey.length > 128))
    || (header !== null && header.length > 128) || !key || (bodyKey && header && bodyKey !== header)) {
    return NextResponse.json({ error: { code: "invalid_task_interrupt", message: "Invalid task interrupt request", details: {} } }, { status: 422 })
  }
  return key
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, taskId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const clientMessageId = parseRequestKey(body, request)
  if (clientMessageId instanceof NextResponse) return clientMessageId
  try {
    const result = await new TaskInterruptService(db).interrupt({ sessionId, taskId, userId: auth.userId, clientMessageId })
    return NextResponse.json(result, { status: 202 })
  } catch (error: unknown) {
    if (error instanceof TaskInterruptError) {
      return NextResponse.json({ error: { code: error.code, message: error.message, details: {} } }, { status: error.status })
    }
    return NextResponse.json({ error: { code: "internal_error", message: "Could not accept the task interrupt", details: {} } }, { status: 500 })
  }
}
