import { NextRequest } from "next/server"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { redactStreamValue } from "@/lib/agent/session/stream-redaction"
import { parseCognitiveAgendaReceipt, type CognitiveAgendaScope } from "@/components/agent-workspace/v2/cognitive-agenda-view"
import { parseSteeringMarkerEvent, reduceTimelineSteeringMarkers, type TimelineSteeringMarkerEvent } from "@/components/agent-workspace/v2/timeline-steering-markers"

import {
  afterCursor,
  pageResult,
  parsePageRequest,
  sessionNotFound,
} from "../../query-helpers"
import { itemDto, type ItemQueryRow } from "../../query-dto"

interface RouteContext {
  params: Promise<{ id: string }>
}

interface AgendaQueryRow {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  sequence: bigint
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
}

type SteeringMarkerQueryRow = Omit<AgendaQueryRow, "type"> & { type: string }

const AGENDA_SELECT = {
  id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
  type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true,
} as const

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const page = parsePageRequest(request, "timeline", sessionId)
  if (page instanceof Response) return page

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  const rows = await db.agentItem.findMany({
    where: { sessionId, ...afterCursor(page.cursor) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    select: {
      id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
      phase: true, revision: true, content: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
    },
  })
  const result = pageResult(rows as ItemQueryRow[], page, "timeline", sessionId)
  const agendas = page.cursor === null ? await recentAgendas(sessionId) : []
  const agenda = page.cursor === null ? agendas[agendas.length - 1] ?? null : null
  const steeringMarkers = page.cursor === null ? await latestSteeringMarkers(sessionId) : []
  return ok({
    items: result.rows.map(itemDto),
    page: result.page,
    ...(page.cursor === null ? { agenda, ...(agendas.length > 0 ? { agendas } : {}), ...(steeringMarkers.length > 0 ? { steeringMarkers } : {}) } : {}),
  })
}

async function recentAgendas(sessionId: string) {
  const rows = await db.agentEvent.findMany({
    where: { sessionId, type: "cognitive.agenda" },
    orderBy: { sequence: "desc" },
    take: 64,
    select: AGENDA_SELECT,
  }) as AgendaQueryRow[]
  return rows.map(row => agendaEnvelope(row, sessionId)).filter((envelope): envelope is NonNullable<typeof envelope> => envelope !== null).reverse()
}

async function latestSteeringMarkers(sessionId: string): Promise<readonly TimelineSteeringMarkerEvent[]> {
  const rows = await db.agentEvent.findMany({
    where: { sessionId, type: "agent.steering.marker" },
    orderBy: { sequence: "desc" },
    take: 128,
    select: AGENDA_SELECT,
  }) as SteeringMarkerQueryRow[]
  const events = rows.flatMap(row => {
    const event = markerEnvelope(row, sessionId)
    return event && parseSteeringMarkerEvent(event, { sessionId }) ? [event] : []
  }).reverse()
  const reduced = reduceTimelineSteeringMarkers(events, { sessionId })
  return reduced.valid ? events : []
}

function markerEnvelope(row: SteeringMarkerQueryRow, sessionId: string): TimelineSteeringMarkerEvent | null {
  if (row.sessionId !== sessionId || row.type !== "agent.steering.marker" || row.itemId !== null || typeof row.taskId !== "string") return null
  const sequence = row.sequence.toString()
  if (!/^(0|[1-9]\d*)$/.test(sequence) || sequence.length > 20) return null
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION,
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    itemId: null,
    taskId: row.taskId,
    type: "agent.steering.marker",
    actor: row.actor as "system",
    sequence,
    payload: redactStreamValue(row.payload),
  }
}

function agendaEnvelope(row: AgendaQueryRow, sessionId: string) {
  if (row.sessionId !== sessionId || row.type !== "cognitive.agenda" || row.itemId !== null ||
    (row.actor !== "orchestrator" && row.actor !== "subagent") || !/^\d{1,39}$/.test(row.sequence.toString())) return null
  const payload = redactStreamValue(row.payload)
  const rawPayload = isRecord(payload) ? payload : {}
  const scope: CognitiveAgendaScope = {
    sessionId: row.sessionId,
    turnId: row.turnId,
    taskId: row.taskId ?? "",
    stepId: typeof rawPayload.stepId === "string" ? rawPayload.stepId : "",
  }
  if (!parseCognitiveAgendaReceipt(payload, scope)) return null
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION,
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    itemId: row.itemId,
    taskId: row.taskId,
    type: row.type,
    actor: row.actor,
    correlationId: row.correlationId,
    causationId: row.causationId,
    idempotencyKey: row.idempotencyKey,
    sequence: row.sequence.toString(),
    payload,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
