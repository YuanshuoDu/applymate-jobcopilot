import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { createAgentSession } from "@/lib/agent/session/repository"
import { AgentSessionIdempotencyConflictError } from "@/lib/agent/session/agent-session-create-idempotency"
import { taskRecoveryAccountScope } from "@/lib/agent/control-plane/commands/objective-start-attempt-read-model"

const STALE_CHAT_SESSION_MS = 30 * 60 * 1000

function scopedResponse(response: Response, accountScope: string): Response {
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-Account-Scope", accountScope)
  return response
}

function serializeSession(session: {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}) {
  return {
    id: session.id,
    goal: session.goal,
    status: session.status,
    source: session.source,
    memorySummary: session.memorySummary,
    qualityScore: session.qualityScore,
    currentTaskId: session.currentTaskId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
  }
}

function readGoal(body: unknown) {
  if (!body || typeof body !== "object") return ""
  const goal = (body as { goal?: unknown }).goal
  return typeof goal === "string" ? goal.trim() : ""
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const completedAt = new Date()
  await db.agentSession.updateMany({
    where: {
      userId: auth.userId,
      source: "chat",
      status: "running",
      updatedAt: { lt: new Date(completedAt.getTime() - STALE_CHAT_SESSION_MS) },
      approvals: { none: { status: "pending" } },
      tasks: { none: { status: { in: ["queued", "running", "retrying", "waiting_for_user"] } } },
      turns: { none: {} },
      // Preserve only a keyed chat with no task/Turn history for client retry.
      // Keyless sessions and sessions with prior task records keep stale cleanup.
      OR: [{ creationIdempotencyKey: null }, { tasks: { some: {} } }],
    },
    data: { status: "completed", completedAt },
  })

  const [sessions, lastOpenedSession] = await Promise.all([
    db.agentSession.findMany({
      where: {
        userId: auth.userId,
        OR: [
          { source: { not: "automation" } },
          { source: "automation", automation: { isNot: null } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        goal: true,
        status: true,
        source: true,
        memorySummary: true,
        qualityScore: true,
        currentTaskId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
    }),
    db.agentSession.findFirst({
      where: {
        userId: auth.userId,
        lastViewedAt: { not: null },
        OR: [
          { source: { not: "automation" } },
          { source: "automation", automation: { isNot: null } },
        ],
      },
      orderBy: { lastViewedAt: "desc" },
      select: { id: true },
    }),
  ])

  return ok({
    sessions: sessions.map(serializeSession),
    // Existing accounts created before this column was introduced should still
    // resume the most recent conversation instead of opening a blank page.
    lastOpenedSessionId: lastOpenedSession?.id ?? sessions[0]?.id ?? null,
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const expectedScope = req.headers.get("x-expected-account-scope")
  const accountScope = taskRecoveryAccountScope(auth.userId)
  const respond = (response: Response) => expectedScope === null ? response : scopedResponse(response, accountScope)
  if (expectedScope !== null && expectedScope !== accountScope) {
    return scopedResponse(err("Task recovery account scope changed", 409), accountScope)
  }

  const idempotencyKey = req.headers.get("idempotency-key")
  if (idempotencyKey !== null && (!idempotencyKey || idempotencyKey.length > 128 || !/^[!-~]+$/.test(idempotencyKey))) {
    return respond(err("Idempotency-Key must contain 1 to 128 visible ASCII characters", 400))
  }
  const goal = readGoal(await req.json().catch(() => null))
  if (!goal) return respond(err("Session goal is required", 400))

  let session: unknown
  try {
    session = await createAgentSession(db, {
      userId: auth.userId,
      goal,
      source: "chat",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
  } catch (error) {
    if (error instanceof AgentSessionIdempotencyConflictError) {
      return respond(err("Idempotency-Key was already used for a different session request", 409))
    }
    throw error
  }
  const sessionRow = session as Parameters<typeof serializeSession>[0]

  return respond(ok({ session: serializeSession(sessionRow) }, 201))
}
