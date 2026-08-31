import { NextRequest } from "next/server"

import { answerQuestion } from "@/lib/agent/broker/store"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import { isResponse, readJsonBody } from "../../../command-route-helpers"
import { parseQuestionAnswer, waitErrorResponse } from "../../../wait-route-helpers"

interface RouteContext {
  params: Promise<{ id: string; questionId: string }>
}

export const runtime = "nodejs"

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, questionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const command = parseQuestionAnswer(body, request)
  if (command instanceof Response) return command
  try {
    const result = await answerQuestion(db, {
      sessionId,
      userId: auth.userId,
      waitId: questionId,
      ...command,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return waitErrorResponse(error)
  }
}
