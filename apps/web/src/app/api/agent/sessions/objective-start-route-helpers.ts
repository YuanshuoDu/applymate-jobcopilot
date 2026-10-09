import { AgentInputCommandSchema, assertValid, schemaVersion, type InputContentPart } from "@jobcopilot/agent-protocol"
import { NextResponse } from "next/server"

import { MAX_ATTACHMENT_REFS, MAX_CONTENT_PARTS, MAX_TEXT_PART_LENGTH } from "./command-route-helpers"

export type ParsedObjectiveStartCommand = {
  clientMessageId: string
  objective: string
  content: InputContentPart[]
}

type RecordBody = Record<string, unknown>

function isRecord(value: unknown): value is RecordBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: RecordBody, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function trimmedString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null
}

function invalid(message: string): NextResponse {
  return NextResponse.json({ error: { code: "invalid_command", message, details: {} } }, { status: 422 })
}

function parseContent(value: unknown): InputContentPart[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTENT_PARTS) return null
  const content: InputContentPart[] = []
  let attachmentCount = 0
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string") return null
    if (part.type === "text") {
      if (!exactKeys(part, ["type", "text"]) || typeof part.text !== "string" || !part.text.trim() || part.text.length > MAX_TEXT_PART_LENGTH) return null
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type !== "attachment_ref" || !exactKeys(part, ["type", "attachmentId", "mediaType", "filename"])) return null
    const attachmentId = trimmedString(part.attachmentId)
    const mediaType = trimmedString(part.mediaType)
    const filename = part.filename === undefined ? undefined : trimmedString(part.filename)
    if (!attachmentId || !mediaType || (part.filename !== undefined && !filename)) return null
    attachmentCount += 1
    if (attachmentCount > MAX_ATTACHMENT_REFS) return null
    content.push({ type: "attachment_ref", attachmentId, mediaType, ...(filename ? { filename } : {}) })
  }
  return content
}

function protocolValid(clientMessageId: string, sessionId: string, content: InputContentPart[]): boolean {
  try {
    assertValid(AgentInputCommandSchema, {
      schemaVersion, clientMessageId, sessionId, expectedTurnId: null, delivery: "follow_up", content,
    }, "agent objective start command")
    return true
  } catch {
    return false
  }
}

export function parseObjectiveStartBody(
  body: unknown,
  request: Request,
  sessionId: string,
): ParsedObjectiveStartCommand | NextResponse {
  if (!isRecord(body) || !exactKeys(body, ["schemaVersion", "clientMessageId", "objective", "content"])) {
    return invalid("Unsupported or forbidden objective start field")
  }
  const clientMessageId = trimmedString(body.clientMessageId)
  const headerId = trimmedString(request.headers.get("idempotency-key"))
  const objective = typeof body.objective === "string" ? body.objective.trim() : ""
  const content = parseContent(body.content)
  if (body.schemaVersion !== schemaVersion || !clientMessageId || !headerId || headerId !== clientMessageId ||
      !objective || new TextEncoder().encode(objective).byteLength > 2_000 || !content ||
      !protocolValid(clientMessageId, sessionId, content)) {
    return invalid("Invalid objective start command payload")
  }
  return { clientMessageId, objective, content }
}
