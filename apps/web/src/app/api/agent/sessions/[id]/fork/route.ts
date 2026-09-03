import { NextRequest } from "next/server"

import { AgentForkService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import { commandErrorResponse, isResponse, parseForkBody, readJsonBody } from "../../command-route-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const command = parseForkBody(body, request)
  if (isResponse(command)) return command

  try {
    const result = await new AgentForkService(db).fork({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      lastTurnId: command.lastTurnId,
      ...(command.editContent ? { editContent: command.editContent } : {}),
    })
    return ok(result, result.disposition === "duplicate" ? 200 : 201)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
