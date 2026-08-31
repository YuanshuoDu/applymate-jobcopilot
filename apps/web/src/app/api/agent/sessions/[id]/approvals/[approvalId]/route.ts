import { NextRequest } from "next/server"

import { decideApproval } from "@/lib/agent/broker/store"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { reissueApprovalNonce } from "@/lib/agent/approval/legacy-receipt"
import { ApprovalStoreError } from "@/lib/agent/approval/types"

import { isResponse, readJsonBody } from "../../../command-route-helpers"
import { parseApprovalDecision, waitErrorResponse } from "../../../wait-route-helpers"

interface RouteContext {
  params: Promise<{ id: string; approvalId: string }>
}

export const runtime = "nodejs"

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(_request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, approvalId } = await context.params
  try {
    return ok(await reissueApprovalNonce(db, { approvalId, sessionId, userId: auth.userId }))
  } catch (error: unknown) {
    if (error instanceof ApprovalStoreError && error.code === "approval_expired") return err(error.message, 410)
    if (error instanceof ApprovalStoreError && error.code === "approval_not_found") return err(error.message, 404)
    return err(error instanceof Error ? error.message : "Approval receipt could not be refreshed", 409)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, approvalId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return body
  const command = parseApprovalDecision(body, request)
  if (command instanceof Response) return command
  try {
    const result = await decideApproval(db, {
      sessionId,
      userId: auth.userId,
      waitId: approvalId,
      ...command,
    })
    return ok(result, 202)
  } catch (error: unknown) {
    return waitErrorResponse(error)
  }
}
