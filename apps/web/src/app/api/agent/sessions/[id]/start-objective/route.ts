import { NextRequest } from "next/server"

import { ObjectiveStartCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { taskRecoveryAccountScope } from "@/lib/agent/control-plane/commands/objective-start-attempt-read-model"

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

function scopedResponse(response: Response, accountScope: string): Response {
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-Account-Scope", accountScope)
  return response
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const expectedScope = request.headers.get("x-expected-account-scope")
  const accountScope = taskRecoveryAccountScope(auth.userId)
  const respond = (response: Response) => expectedScope === null ? response : scopedResponse(response, accountScope)
  if (expectedScope !== null && expectedScope !== accountScope) {
    return scopedResponse(err("Task recovery account scope changed", 409), accountScope)
  }

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return respond(body)
  const command = parseObjectiveStartBody(body, request, sessionId)
  if (isResponse(command)) return respond(command)
  const attachmentError = await verifyAttachmentOwnership(db, auth.userId, command.content)
  if (attachmentError) return respond(attachmentError)

  try {
    const result = await new ObjectiveStartCommandService(db).start({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      objective: command.objective,
      content: command.content,
      ...(Object.hasOwn(command, "verificationRequirements")
        ? { verificationRequirements: command.verificationRequirements }
        : {}),
    })
    return respond(ok(result, 202))
  } catch (error: unknown) {
    return respond(commandErrorResponse(error))
  }
}
