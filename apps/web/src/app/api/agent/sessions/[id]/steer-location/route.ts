import {
  ObjectiveLocationSteerRequestSchema,
  validate,
  type ObjectiveLocationSteerRequest,
} from "@jobcopilot/agent-protocol"
import { NextRequest } from "next/server"

import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { objectiveLocationVerificationEnabled } from "@/lib/agent/control-plane/commands/types"
import { acceptObjectiveLocationSteer } from "@/lib/agent/control-plane/commands/objective-location-steer"
import { db } from "@/lib/db"

import { commandErrorResponse, isResponse, readJsonBody } from "../../command-route-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

function invalidCommand() {
  return Response.json({ error: { code: "invalid_command", message: "Invalid objective location steer command", details: {} } }, { status: 422 })
}

function locationSteeringUnavailable() {
  return Response.json({
    error: { code: "objective_location_verification_unavailable", message: "Objective location steering is not enabled yet", details: {} },
  }, { status: 422 })
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  if (!validate(ObjectiveLocationSteerRequestSchema, body)) return invalidCommand()

  const command = body as ObjectiveLocationSteerRequest
  if (request.headers.get("idempotency-key") !== command.clientMessageId) return invalidCommand()
  if (!objectiveLocationVerificationEnabled()) return locationSteeringUnavailable()

  try {
    const result = await acceptObjectiveLocationSteer(db, { ...command, userId: auth.userId, sessionId })
    return ok(result, 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
