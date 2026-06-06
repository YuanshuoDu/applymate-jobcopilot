import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const runs = await db.agentRun.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return ok({
    runs: runs.map(run => ({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      durationMs: run.durationMs,
      stagesCompleted: run.stagesCompleted,
      jobsFound: run.jobsFound,
      status: run.status,
      report: run.report,
      log: run.log,
    })),
  })
}
