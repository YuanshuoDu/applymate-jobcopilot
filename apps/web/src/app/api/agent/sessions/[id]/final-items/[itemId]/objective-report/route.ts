import { NextRequest } from "next/server"
import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { runWithTenantContext } from "@/lib/db/tenant-store"
import { readObjectiveJourneyReport } from "@/lib/agent/session/objective-journey-report"

export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string; itemId: string }> }

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateResponse(auth)
  const { id: sessionId, itemId } = await context.params
  if (!validId(sessionId) || !validId(itemId) || new URL(request.url).search !== "") return unavailable()
  const report = await runWithTenantContext(auth.userId,
    () => readObjectiveJourneyReport({ userId: auth.userId, sessionId, finalItemId: itemId }))
  return report ? privateResponse(Response.json({ report })) : unavailable()
}

function unavailable(): Response {
  return privateResponse(Response.json({ error: { code: "objective_journey_report_unavailable",
    message: "The Objective journey report is unavailable.", details: {} } }, { status: 404 }))
}

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0")
  return response
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
