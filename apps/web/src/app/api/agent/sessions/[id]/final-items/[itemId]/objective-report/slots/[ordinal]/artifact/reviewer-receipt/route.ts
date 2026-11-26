import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"
import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { runWithTenantContext } from "@/lib/db/tenant-store"
import { readObjectiveSlotReviewerReceiptEvidence } from "@/lib/agent/session/objective-slot-artifact"

export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string; itemId: string; ordinal: string }> }

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateResponse(auth)
  const { id: sessionId, itemId, ordinal: ordinalText } = await context.params
  const url = new URL(request.url), params = [...url.searchParams.entries()]
  const graphRevisionText = url.searchParams.get("graphRevision")
  const ordinal = Number(ordinalText), graphRevision = Number(graphRevisionText)
  if (!validId(sessionId) || !validId(itemId) || !positive(ordinal) || String(ordinal) !== ordinalText || ordinal > 8
    || params.length !== 1 || params[0]?.[0] !== "graphRevision" || !positive(graphRevision) || String(graphRevision) !== graphRevisionText) return unavailable()
  try {
    const receipt = await runWithTenantContext(auth.userId, () => db.$transaction(tx => readObjectiveSlotReviewerReceiptEvidence(tx, {
      userId: auth.userId, sessionId, finalItemId: itemId, graphRevision, slotOrdinal: ordinal,
    }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }))
    return receipt ? privateResponse(Response.json({ reviewerReceipt: receipt })) : unavailable()
  } catch { return unavailable() }
}

function unavailable(): Response {
  return privateResponse(Response.json({ error: { code: "objective_slot_reviewer_receipt_unavailable",
    message: "The Objective slot Reviewer receipt is unavailable.", details: {} } }, { status: 404 }))
}
function privateResponse(response: Response): Response { response.headers.set("Cache-Control", "private, no-store, max-age=0"); return response }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
