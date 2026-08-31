import { NextRequest } from "next/server"

import { AgentCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  commandErrorResponse,
  isResponse,
  parseMessageBody,
  readJsonBody,
  verifyAttachmentOwnership,
} from "../../command-route-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body

  const command = parseMessageBody(body, request, sessionId)
  if (isResponse(command)) return command
  const attachmentError = await verifyAttachmentOwnership(db, auth.userId, command.content)
  if (attachmentError) return attachmentError

  try {
    const result = await new AgentCommandService(db).message({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      delivery: command.delivery,
      expectedTurnId: command.expectedTurnId,
      expectedRevision: command.expectedRevision,
      content: command.content,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
