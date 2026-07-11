import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"

type RouteCtx = { params: Promise<{ id: string }> }

type AutomationRow = {
  id: string
  name: string
  enabled: boolean
  triggerType: string
  cron: string | null
  timezone: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
  createdBy: string
  lastRunAt: Date | null
  nextRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function serializeAutomation(row: AutomationRow) {
  return {
    ...row,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : null
}

function numberInRange(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, Math.round(value)))
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return null
  return value
    .map(item => text(item))
    .filter((item): item is string => Boolean(item))
}

function readPatchData(body: unknown, current?: { cron: string | null; timezone: string }) {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const data: Record<string, boolean | string | string[] | number | Date | null> = {}
  const name = text(row.name)
  const triggerType = text(row.triggerType)
  const cron = text(row.cron)
  const timezone = text(row.timezone)
  const targetRoles = stringList(row.targetRoles)
  const targetLocations = stringList(row.targetLocations)
  const minScore = numberInRange(row.minScore, 0, 100)
  const dailyCap = numberInRange(row.dailyCap, 1, 50)

  if (typeof row.enabled === "boolean") data.enabled = row.enabled
  if (name) data.name = name
  if (triggerType) data.triggerType = triggerType
  if ("cron" in row) {
    data.cron = cron || null
  }
  if (timezone) data.timezone = timezone
  if (targetRoles) data.targetRoles = targetRoles
  if (targetLocations) data.targetLocations = targetLocations
  if (minScore !== null) data.minScore = minScore
  if (dailyCap !== null) data.dailyCap = dailyCap
  if (typeof row.requireApproval === "boolean") data.requireApproval = row.requireApproval
  if (typeof row.autoApply === "boolean") data.autoApply = row.autoApply
  if ("cron" in row || timezone) {
    const nextCron = "cron" in row ? cron || null : current?.cron ?? null
    const nextTimezone = timezone || current?.timezone || "UTC"
    data.nextRunAt = nextRunAtFromCron(nextCron, new Date(), nextTimezone)
  }

  return data
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const needsScheduleContext = Boolean(body && typeof body === "object" && ("cron" in body || "timezone" in body))
  const current = needsScheduleContext
    ? await db.agentAutomation.findFirst({
      where: { id, userId: auth.userId },
      select: { cron: true, timezone: true },
    }) as { cron: string | null; timezone: string } | null
    : null
  if (needsScheduleContext && !current) return err("Automation not found", 404)

  const data = readPatchData(body, current ?? undefined)
  if (Object.keys(data).length === 0) return err("No automation updates provided", 400)

  const result = await db.agentAutomation.updateMany({
    where: { id, userId: auth.userId },
    data,
  })
  if (result.count === 0) return err("Automation not found", 404)

  const automation = await db.agentAutomation.findFirst({
    where: { id, userId: auth.userId },
  })
  if (!automation) return err("Automation not found", 404)

  return ok({ automation: serializeAutomation(automation) })
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const result = await db.agentAutomation.deleteMany({
    where: { id, userId: auth.userId },
  })
  if (result.count === 0) return err("Automation not found", 404)

  return ok({ ok: true })
}
