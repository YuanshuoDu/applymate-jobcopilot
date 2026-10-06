import { NextRequest } from "next/server"

import { ObjectiveStartCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  commandErrorResponse,
  isResponse,
  readJsonBody,
  verifyAttachmentOwnership,
} from "../../command-route-helpers"
import { parseObjectiveStartBody } from "../../objective-start-route-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const command = parseObjectiveStartBody(body, request, sessionId)
  if (isResponse(command)) return command
  const attachmentError = await verifyAttachmentOwnership(db, auth.userId, command.content)
  if (attachmentError) return attachmentError

  try {
    const result = await new ObjectiveStartCommandService(db).start({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      objective: command.objective,
      content: command.content,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
