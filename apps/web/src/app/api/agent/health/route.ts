import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

interface ApplyHealthRow {
  status: string
  flowUsed: string | null
  error: string | null
  durationMs: number | null
  createdAt: Date
}

function pct(numerator: number, denominator: number) {
  if (denominator === 0) return 0
  return Number(((numerator / denominator) * 100).toFixed(1))
}

function summarize(rows: ApplyHealthRow[]) {
  const total = rows.length
  const durations = rows
    .map(row => row.durationMs)
    .filter((duration): duration is number => typeof duration === "number")
  const avgDurationMs = durations.length === 0
    ? 0
    : Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000

  return {
    successRate: pct(rows.filter(row => row.status === "submitted").length, total),
    captchaRate: pct(rows.filter(row => row.error?.toLowerCase().includes("captcha")).length, total),
    avgDurationMs,
    patternCacheRate: pct(rows.filter(row => row.flowUsed === "pattern-cache").length, total),
    last24hRuns: rows.filter(row => row.createdAt.getTime() > oneDayAgo).length,
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const rows = await db.applyResult.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      status: true,
      flowUsed: true,
      error: true,
      durationMs: true,
      createdAt: true,
    },
  })

  return ok(summarize(rows))
}
