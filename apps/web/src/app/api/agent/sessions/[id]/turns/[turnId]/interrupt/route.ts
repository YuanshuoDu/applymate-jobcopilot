import { NextRequest } from "next/server"

import { AgentCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  commandErrorResponse,
  isResponse,
  parseInterruptBody,
  readJsonBody,
} from "../../../../command-route-helpers"

interface RouteContext {
  params: Promise<{ id: string; turnId: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId, turnId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const command = parseInterruptBody(body, request)
  if (isResponse(command)) return command

  try {
    const result = await new AgentCommandService(db).interrupt({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      expectedTurnId: turnId,
      expectedRevision: command.expectedRevision,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
