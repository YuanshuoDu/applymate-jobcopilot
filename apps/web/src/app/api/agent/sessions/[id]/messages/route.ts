import { NextRequest } from "next/server"

import { AgentCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

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

  if (command.selectedJobPreparation) {
    const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
    if (!session) return err("Session not found", 404)
    const job = await db.job.findFirst({
      where: { id: command.selectedJobPreparation.jobId, userId: auth.userId },
      select: { id: true },
    })
    if (!job) return err("Job not found", 404)
  }

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
      selectedJobPreparation: command.selectedJobPreparation,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return commandErrorResponse(error)
  }
}
