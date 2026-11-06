import { NextRequest } from "next/server"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { waitItemId } from "@/lib/agent/broker/item-ids"
import { redactStreamValue } from "@/lib/agent/session/stream-redaction"
import { openPublicTimelineCursor, publicAgentEventId, publicToolCallId, projectPublicEventEnvelope, sealPublicTimelineCursor } from "@/lib/agent/session/public-tool-identity"
import { APPROVAL_LEDGER_EVENT_TYPES, APPROVAL_LEDGER_MAX_EVENTS, projectApprovalLedgerRow } from "@/components/agent-workspace/v2/approval-ledger-parser"
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
interface ApprovalDecisionQueryRow { id: string; userId: string; sessionId: string; turnId: string | null; taskId: string | null; toolCallId: string | null; type: string; scopeHash: string | null; revision: number; status: string }

const AGENDA_SELECT = {
  id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
  type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true,
} as const

const APPROVAL_DECISION_SELECT = { id: true, userId: true, sessionId: true, turnId: true, taskId: true, toolCallId: true, type: true, scopeHash: true, revision: true, status: true } as const
const APPROVAL_LEDGER_QUERY_LIMIT = APPROVAL_LEDGER_MAX_EVENTS * 4
const ITEM_QUERY_SELECT = {
  id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
  phase: true, revision: true, content: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
} as const

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const query = new URL(request.url).searchParams
  const itemIds = query.getAll("itemId")
  if (itemIds.length > 0) {
    const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
    if (!session) return sessionNotFound()
    const itemId = itemIds[0]
    if (itemIds.length !== 1 || query.size !== 1 || !safeTimelineId(itemId)) {
      return Response.json({ error: { code: "invalid_item_id", message: "itemId must be the only safe timeline query parameter", details: {} } }, { status: 400 })
    }
    const row = await db.agentItem.findFirst({ where: { id: itemId, sessionId }, select: ITEM_QUERY_SELECT })
    if (!row) return Response.json({ error: { code: "timeline_item_not_found", message: "Timeline item not found", details: {} } }, { status: 404 })
    return ok({ items: [itemDto(row as ItemQueryRow)], page: { hasMore: false, nextCursor: null } })
  }
  const incomingCursor = query.get("cursor")
  const internalCursor = incomingCursor ? openPublicTimelineCursor(sessionId, incomingCursor) : null
  if (incomingCursor && !internalCursor) return Response.json({ error: { code: "invalid_cursor", message: "Cursor is invalid or belongs to another query", details: {} } }, { status: 400 })
  const pageRequest = internalCursor && internalCursor !== incomingCursor ? withCursor(request, internalCursor) : request
  const page = parsePageRequest(pageRequest, "timeline", sessionId)
  if (page instanceof Response) return page

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  const rows = await db.agentItem.findMany({
    where: { sessionId, ...afterCursor(page.cursor) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    select: ITEM_QUERY_SELECT,
  })
  const result = pageResult(rows as ItemQueryRow[], page, "timeline", sessionId)
  const agendas = page.cursor === null ? await recentAgendas(sessionId) : []
  const agenda = page.cursor === null ? agendas[agendas.length - 1] ?? null : null
  const steeringMarkers = page.cursor === null ? await latestSteeringMarkers(sessionId) : []
  const approvalEvents = page.cursor === null ? await recentApprovalEvents(sessionId, auth.userId) : []
  return ok({
    items: result.rows.map(itemDto),
    page: { ...result.page, nextCursor: result.page.nextCursor ? sealPublicTimelineCursor(sessionId, result.page.nextCursor) : null },
    ...(page.cursor === null ? {
      agenda,
      ...(agendas.length > 0 ? { agendas } : {}),
      ...(steeringMarkers.length > 0 ? { steeringMarkers } : {}),
      ...(approvalEvents.length > 0 ? { approvalEvents } : {}),
    } : {}),
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

async function recentApprovalEvents(sessionId: string, userId: string) {
  const rows = await db.agentEvent.findMany({ where: { sessionId, type: { in: [...APPROVAL_LEDGER_EVENT_TYPES] } },
    orderBy: { sequence: "desc" }, take: APPROVAL_LEDGER_QUERY_LIMIT, select: AGENDA_SELECT }) as AgendaQueryRow[]
  const ids = [...new Set(rows.flatMap(row => { const payload = isRecord(row.payload) ? row.payload : {}
    return row.type === "approval.resolved" && row.actor === "user" && payload.waitKind === "approval" && payload.answerAvailable === "[REDACTED]" && safeTimelineId(payload.waitId) ? [payload.waitId] : []
  }))]
  const decisions = ids.length ? await db.agentApproval.findMany({ where: { id: { in: ids }, userId, sessionId }, select: APPROVAL_DECISION_SELECT }) as ApprovalDecisionQueryRow[] : []
  const decisionsById = new Map<string, ApprovalDecisionQueryRow[]>()
  for (const decision of decisions) decisionsById.set(decision.id, [...(decisionsById.get(decision.id) ?? []), decision])
  return rows.flatMap(row => {
    const projectedRow = restoreLegacyRedactedAnswer(row, sessionId, userId, decisionsById, rows)
    const event = projectApprovalLedgerRow(projectedRow, sessionId, redactStreamValue)
    if (!event) return []
    const payload = isRecord(event.payload) ? event.payload : {}
    return [{
      ...event, id: publicAgentEventId(sessionId, event.id),
      payload: typeof payload.toolCallId === "string"
        ? { ...payload, toolCallId: publicToolCallId(sessionId, event.turnId, payload.toolCallId) }
        : event.payload,
    }]
  }).sort((left, right) => compareDecimalSequence(left.sequence, right.sequence) || left.id.localeCompare(right.id))
}
function restoreLegacyRedactedAnswer(row: AgendaQueryRow, sessionId: string, userId: string, decisions: ReadonlyMap<string, readonly ApprovalDecisionQueryRow[]>, events: readonly AgendaQueryRow[]): AgendaQueryRow {
  const payload = isRecord(row.payload) ? row.payload : null
  if (row.sessionId !== sessionId || row.type !== "approval.resolved" || row.actor !== "user" || !payload ||
    payload.waitKind !== "approval" || payload.answerAvailable !== "[REDACTED]" || !safeTimelineId(payload.waitId) ||
    !safeTimelineId(payload.itemId) || !safeTimelineId(payload.turnId) || (payload.toolCallId !== null && !safeTimelineId(payload.toolCallId)) ||
    (payload.status !== "approved" && payload.status !== "rejected")) return row
  const matches = decisions.get(payload.waitId) ?? []
  const decision = matches[0]
  const itemId = waitItemId("approval", payload.waitId)
  const consumed = relatedConsumedApprovals(events, payload.waitId)
  const statusMatches = decision?.status === "consumed"
    ? payload.status === "approved" && consumed.length === 1 && canonicalConsumedApproval(consumed[0]!, row, decision, sessionId)
    : (decision?.status === "approved" || decision?.status === "rejected") && payload.status === decision.status && consumed.length === 0
  if (matches.length !== 1 || !decision || decision.id !== payload.waitId || decision.userId !== userId || decision.sessionId !== sessionId ||
    decision.turnId !== row.turnId || decision.taskId !== row.taskId || row.itemId !== itemId || payload.itemId !== itemId ||
    payload.turnId !== row.turnId || row.correlationId !== payload.waitId || row.causationId !== itemId ||
    payload.toolCallId !== decision.toolCallId || !statusMatches) return row
  return { ...row, payload: { ...payload, answerAvailable: false } }
}
function relatedConsumedApprovals(events: readonly AgendaQueryRow[], approvalId: string): AgendaQueryRow[] {
  const key = "approval:" + approvalId + ":consumed"
  return events.filter(event => event.type === "approval.consumed" && (event.correlationId === approvalId || event.idempotencyKey === key ||
    (isRecord(event.payload) && event.payload.approvalId === approvalId)))
}
function canonicalConsumedApproval(event: AgendaQueryRow, resolved: AgendaQueryRow, approval: ApprovalDecisionQueryRow, sessionId: string): boolean {
  const payload = isRecord(event.payload) ? event.payload : null, keys = payload ? Object.keys(payload) : []
  return !!payload && !!projectApprovalLedgerRow(event, sessionId, redactStreamValue) && event.sessionId === sessionId &&
    event.turnId === approval.turnId && event.taskId === approval.taskId && event.itemId === null && event.actor === "system" &&
    event.correlationId === approval.id && event.causationId === null && event.idempotencyKey === "approval:" + approval.id + ":consumed" &&
    event.sequence > resolved.sequence && keys.length === 4 && ["approvalId", "action", "scopeHash", "revision"].every(key => keys.includes(key)) &&
    (payload.approvalId === approval.id || payload.approvalId === "[REDACTED]") && payload.action === approval.type &&
    typeof approval.scopeHash === "string" && payload.scopeHash === approval.scopeHash && payload.revision === approval.revision
}
function compareDecimalSequence(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1
}

function markerEnvelope(row: SteeringMarkerQueryRow, sessionId: string): TimelineSteeringMarkerEvent | null {
  if (row.sessionId !== sessionId || row.type !== "agent.steering.marker" || row.itemId !== null || typeof row.taskId !== "string") return null
  const sequence = row.sequence.toString()
  if (!/^(0|[1-9]\d*)$/.test(sequence) || sequence.length > 20) return null
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION,
    id: publicAgentEventId(sessionId, row.id),
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
  const rawPayload = isRecord(row.payload) ? row.payload : {}
  const scope: CognitiveAgendaScope = {
    sessionId: row.sessionId,
    turnId: row.turnId,
    taskId: row.taskId ?? "",
    stepId: typeof rawPayload.stepId === "string" ? rawPayload.stepId : "",
  }
  const agenda = parseCognitiveAgendaReceipt(row.payload, scope)
  if (!agenda) return null
  return projectPublicEventEnvelope({
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
    payload: redactStreamValue(agenda),
  })
}

function withCursor(request: Request, cursor: string): Request {
  const url = new URL(request.url)
  url.searchParams.set("cursor", cursor)
  return new Request(url, { method: request.method, headers: request.headers, signal: request.signal })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeTimelineId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
