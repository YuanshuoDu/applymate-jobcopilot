import {
  AgentSessionControlCommandSchema, schemaVersion, validate,
  type AgentSessionControlAction, type AgentSessionControlCommand,
} from "@jobcopilot/agent-protocol"
import { NextResponse } from "next/server"

export const MAX_SESSION_CONTROL_BODY_BYTES = 4 * 1024
const ALLOWED_KEYS = ["schemaVersion", "clientMessageId", "action", "expectedTurnId", "expectedRevision"] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(message: string): NextResponse {
  return NextResponse.json({ error: { code: "invalid_command", message, details: {} } }, { status: 422 })
}

function id(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null
}

function requestKey(body: Record<string, unknown>, request: Request): string | null {
  const bodyKey = body.clientMessageId === undefined ? null : id(body.clientMessageId)
  const headerKey = id(request.headers.get("idempotency-key"))
  if (body.clientMessageId !== undefined && !bodyKey || bodyKey && headerKey && bodyKey !== headerKey) return null
  return bodyKey ?? headerKey
}

export type ParsedSessionControlCommand = Omit<AgentSessionControlCommand, "schemaVersion">

export async function parseSessionControlRequest(request: Request, sessionId: string): Promise<ParsedSessionControlCommand | NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SESSION_CONTROL_BODY_BYTES) return invalid("Command payload exceeds the size limit")
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_SESSION_CONTROL_BODY_BYTES) return invalid("Command payload exceeds the size limit")

  let body: unknown
  try { body = JSON.parse(raw) as unknown } catch { return invalid("Command body must be valid JSON") }
  if (!record(body) || Object.keys(body).some(key => !ALLOWED_KEYS.includes(key as typeof ALLOWED_KEYS[number]))) {
    return invalid("Unsupported or forbidden session control field")
  }
  const clientMessageId = requestKey(body, request)
  const expectedTurnId = id(body.expectedTurnId)
  const action: AgentSessionControlAction | null = body.action === "pause" || body.action === "resume" ? body.action : null
  const expectedRevision = body.expectedRevision
  if (!clientMessageId || !expectedTurnId || !action
    || (body.schemaVersion !== undefined && body.schemaVersion !== schemaVersion)
    || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2_147_483_647) {
    return invalid("Invalid session control command payload")
  }
  const command: ParsedSessionControlCommand = { sessionId, clientMessageId, action, expectedTurnId, expectedRevision }
  if (!validate(AgentSessionControlCommandSchema, { schemaVersion, ...command })) return invalid("Session control command failed protocol validation")
  return command
}

export function isControlResponse(value: unknown): value is NextResponse { return value instanceof NextResponse }
