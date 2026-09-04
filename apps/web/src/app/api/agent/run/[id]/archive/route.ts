import { schemaVersion } from "@jobcopilot/agent-protocol"
import { NextRequest } from "next/server"

import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

type HistoricalAgentRun = {
  id: string
  status: string
  durationMs: number
  stagesCompleted: number
  jobsFound: number
  createdAt: Date
}

function historicalRunDto(run: HistoricalAgentRun) {
  return {
    schemaVersion,
    id: run.id,
    status: run.status,
    durationMs: run.durationMs,
    stagesCompleted: run.stagesCompleted,
    jobsFound: run.jobsFound,
    createdAt: run.createdAt.toISOString(),
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id } = await context.params
  const run = await db.agentRun.findFirst({
    where: { id, userId: auth.userId },
    select: {
      id: true,
      status: true,
      durationMs: true,
      stagesCompleted: true,
      jobsFound: true,
      createdAt: true,
    },
  })

  if (!run) return err("Agent run not found", 404)

  return ok({ run: historicalRunDto(run) })
}
