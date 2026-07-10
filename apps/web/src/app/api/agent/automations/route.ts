import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"

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

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => text(item))
    .filter(Boolean)
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function readCreateInput(body: unknown) {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {}
  return {
    name: text(row.name),
    enabled: bool(row.enabled, true),
    triggerType: text(row.triggerType, "manual") || "manual",
    cron: text(row.cron) || null,
    timezone: text(row.timezone, "Europe/Berlin") || "Europe/Berlin",
    targetRoles: stringList(row.targetRoles),
    targetLocations: stringList(row.targetLocations),
    minScore: numberInRange(row.minScore, 85, 0, 100),
    dailyCap: numberInRange(row.dailyCap, 8, 1, 50),
    requireApproval: bool(row.requireApproval, true),
    autoApply: bool(row.autoApply, false),
    createdBy: text(row.createdBy, "user") === "agent" ? "agent" : "user",
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const automations = await db.agentAutomation.findMany({
    where: { userId: auth.userId },
    orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
  })

  return ok({ automations: automations.map(serializeAutomation) })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const input = readCreateInput(await req.json().catch(() => null))
  if (!input.name) return err("Automation name is required", 400)

  const existing = await db.agentAutomation.findFirst({
    where: { userId: auth.userId, name: input.name },
    select: { id: true },
  })
  const data = {
    userId: auth.userId,
    ...input,
    nextRunAt: nextRunAtFromCron(input.cron, new Date(), input.timezone),
  }
  const automation = existing
    ? await db.agentAutomation.update({ where: { id: existing.id }, data })
    : await db.agentAutomation.create({ data })

  return ok({ automation: serializeAutomation(automation), mode: existing ? "updated_existing" : "created_new" }, existing ? 200 : 201)
}
