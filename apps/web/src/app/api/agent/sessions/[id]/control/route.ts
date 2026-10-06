import { NextRequest } from "next/server"

import { AgentSessionControlService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { commandErrorResponse } from "../../command-route-helpers"
import { isControlResponse, parseSessionControlRequest } from "./route-helpers"

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const command = await parseSessionControlRequest(request, sessionId)
  if (isControlResponse(command)) return command
  try {
    const result = await new AgentSessionControlService(db).control({ ...command, userId: auth.userId })
    return ok(result, result.disposition === "duplicate" ? 200 : 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
