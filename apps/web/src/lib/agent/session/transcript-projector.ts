import { Prisma, PrismaClient } from "@prisma/client"
import type { AppendTranscriptEventInput } from "./repository"

const MARKER_KEY = "__agentHarnessV2"

interface ProjectionMarker {
  eventId: string
  opaque: boolean
  wrapped: boolean
}

export interface ProjectableEvent {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: string
  payload: unknown
  createdAt?: Date | string
}

interface LegacyProjection {
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown
  durationMs: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function legacyFromPayload(payload: unknown): LegacyProjection | null {
  if (!isRecord(payload) || !isRecord(payload.legacy)) return null
  const legacy = payload.legacy
  if (typeof legacy.type !== "string" || typeof legacy.speaker !== "string" || typeof legacy.body !== "string") return null
  return {
    type: legacy.type,
    speaker: legacy.speaker,
    title: typeof legacy.title === "string" ? legacy.title : null,
    body: legacy.body,
    data: legacy.data ?? null,
    durationMs: typeof legacy.durationMs === "number" ? legacy.durationMs : null,
  }
}

function opaqueProjection(event: ProjectableEvent): LegacyProjection {
  const payload = isRecord(event.payload) && "sourcePayload" in event.payload ? event.payload.sourcePayload : event.payload
  return {
    type: "error",
    speaker: "System",
    title: "Opaque agent event",
    body: `Preserved an unrecognized agent event: ${event.type}`,
    data: { opaque: true, eventType: event.type, payload },
    durationMs: null,
  }
}

export function projectV2EventToTranscript(event: ProjectableEvent): AppendTranscriptEventInput {
  const legacy = legacyFromPayload(event.payload) ?? opaqueProjection(event)
  const opaque = legacy.type === "error" && isRecord(legacy.data) && legacy.data.opaque === true
  const wrapped = !isRecord(legacy.data)
  const projectionData = isRecord(legacy.data)
    ? { ...legacy.data, [MARKER_KEY]: { eventId: event.id, opaque, wrapped } }
    : { legacyValue: legacy.data, [MARKER_KEY]: { eventId: event.id, opaque, wrapped } }
  return {
    sessionId: event.sessionId,
    taskId: event.taskId,
    type: legacy.type as AppendTranscriptEventInput["type"],
    speaker: legacy.speaker,
    title: legacy.title,
    body: legacy.body,
    durationMs: legacy.durationMs,
    data: projectionData,
  }
}

export function transcriptProjectionMarker(value: unknown): ProjectionMarker | null {
  if (!isRecord(value) || !isRecord(value[MARKER_KEY])) return null
  const marker = value[MARKER_KEY]
  return typeof marker.eventId === "string" && typeof marker.opaque === "boolean" &&
    (marker.wrapped === undefined || typeof marker.wrapped === "boolean")
    ? { eventId: marker.eventId, opaque: marker.opaque, wrapped: marker.wrapped === true }
    : null
}

export interface TranscriptGoldenComparison {
  matches: boolean
  differences: string[]
}

type TranscriptComparable = Pick<AppendTranscriptEventInput, "type" | "speaker" | "title" | "body" | "data" | "durationMs">

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? "null"
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
}

export function legacyTranscriptData(value: unknown) {
  const marker = transcriptProjectionMarker(value)
  if (!isRecord(value) || !marker) return value
  const unmarked = Object.fromEntries(Object.entries(value).filter(([key]) => key !== MARKER_KEY))
  if (marker.wrapped && Object.keys(unmarked).length === 1 && "legacyValue" in unmarked) return unmarked.legacyValue
  return unmarked
}

/** Compares user-visible transcript semantics while ignoring projector metadata. */
export function compareTranscriptGolden(
  legacy: TranscriptComparable,
  projected: TranscriptComparable,
): TranscriptGoldenComparison {
  const differences: string[] = []
  for (const field of ["type", "speaker", "title", "body", "durationMs"] as const) {
    if ((legacy[field] ?? null) !== (projected[field] ?? null)) differences.push(field)
  }
  if (stableJson(legacy.data) !== stableJson(legacyTranscriptData(projected.data))) differences.push("data")
  return { matches: differences.length === 0, differences }
}

export async function insertProjectedTranscript(
  tx: Prisma.TransactionClient,
  event: ProjectableEvent,
): Promise<unknown> {
  const projection = projectV2EventToTranscript(event)
  return tx.agentTranscriptEvent.create({
    data: {
      sessionId: projection.sessionId,
      taskId: projection.taskId ?? null,
      type: projection.type,
      speaker: projection.speaker,
      title: projection.title ?? null,
      body: projection.body,
      data: projection.data as Prisma.InputJsonValue,
      durationMs: projection.durationMs,
    },
  })
}

/** Rebuilds the legacy view idempotently from append-only V2 events. */
export async function projectV2EventsToTranscript(
  db: PrismaClient,
  input: { sessionId: string; userId: string; turnId?: string },
): Promise<number> {
  return db.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_sessions"
      WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
      FOR UPDATE
    `)
    if (!owned[0]) return 0

    const events = await tx.agentEvent.findMany({
      where: { sessionId: input.sessionId, ...(input.turnId ? { turnId: input.turnId } : {}) },
      orderBy: { sequence: "asc" },
    })
    const existing = await tx.agentTranscriptEvent.findMany({
      where: { sessionId: input.sessionId },
      select: { data: true },
    })
    const projectedIds = new Set(existing.map(row => transcriptProjectionMarker(row.data)?.eventId).filter((id): id is string => Boolean(id)))
    let inserted = 0
    for (const event of events) {
      if (projectedIds.has(event.id)) continue
      await insertProjectedTranscript(tx, event)
      projectedIds.add(event.id)
      inserted += 1
    }
    return inserted
  })
}
