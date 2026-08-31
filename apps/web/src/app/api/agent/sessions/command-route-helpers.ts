import type { PrismaClient } from "@prisma/client"
import { AgentInputCommandSchema, assertValid, schemaVersion, type InputContentPart } from "@jobcopilot/agent-protocol"
import { NextResponse } from "next/server"

import { AgentCommandError } from "@/lib/agent/control-plane/commands"

export const MAX_COMMAND_BODY_BYTES = 256 * 1024
export const MAX_CONTENT_PARTS = 32
export const MAX_TEXT_PART_LENGTH = 20_000
export const MAX_ATTACHMENT_REFS = 8

export type ParsedMessageCommand = {
  clientMessageId: string
  delivery: "steer" | "follow_up"
  expectedTurnId: string | null
  expectedRevision: number | null
  content: InputContentPart[]
}

export type ParsedInterruptCommand = {
  clientMessageId: string
  expectedRevision: number | null
}

type RecordBody = Record<string, unknown>

function isRecord(value: unknown): value is RecordBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(message: string, code = "invalid_command") {
  return NextResponse.json({ error: { code, message, details: {} } }, { status: 422 })
}

function isAllowedKeys(body: RecordBody, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key))
}

function stringValue(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null
}

function optionalRevision(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function commandId(body: RecordBody, request: Request): string | null {
  const bodyId = body.clientMessageId === undefined ? null : stringValue(body.clientMessageId)
  const headerId = stringValue(request.headers.get("idempotency-key"))
  if (body.clientMessageId !== undefined && !bodyId) return null
  if (bodyId && headerId && bodyId !== headerId) return null
  return bodyId ?? headerId
}

export async function readJsonBody(request: Request): Promise<unknown | NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMMAND_BODY_BYTES) {
    return invalid("Command payload exceeds the size limit")
  }

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_COMMAND_BODY_BYTES) {
    return invalid("Command payload exceeds the size limit")
  }
  try {
    return JSON.parse(raw)
  } catch {
    return invalid("Command body must be valid JSON")
  }
}

function parseContent(value: unknown): InputContentPart[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTENT_PARTS) return null
  let attachmentCount = 0
  const parts: InputContentPart[] = []
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string") return null
    if (part.type === "text") {
      if (!isAllowedKeys(part, ["type", "text"])) return null
      const text = stringValue(part.text, MAX_TEXT_PART_LENGTH)
      if (!text) return null
      parts.push({ type: "text", text })
      continue
    }
    if (part.type !== "attachment_ref") return null
    if (!isAllowedKeys(part, ["type", "attachmentId", "mediaType", "filename"])) return null
    attachmentCount += 1
    if (attachmentCount > MAX_ATTACHMENT_REFS) return null
    const attachmentId = stringValue(part.attachmentId)
    const mediaType = stringValue(part.mediaType)
    const filename = part.filename === undefined ? undefined : stringValue(part.filename)
    if (!attachmentId || !mediaType || (part.filename !== undefined && !filename)) return null
    parts.push({ type: "attachment_ref", attachmentId, mediaType, ...(filename ? { filename } : {}) })
  }
  return parts
}

function validateProtocolCommand(command: unknown): boolean {
  try {
    assertValid(AgentInputCommandSchema, command, "agent message command")
    return true
  } catch {
    return false
  }
}

export function parseMessageBody(body: unknown, request: Request, sessionId: string): ParsedMessageCommand | NextResponse {
  if (!isRecord(body) || !isAllowedKeys(body, ["schemaVersion", "clientMessageId", "delivery", "expectedTurnId", "expectedRevision", "content"])) {
    return invalid("Unsupported or forbidden command field")
  }
  const clientMessageId = commandId(body, request)
  const delivery = body.delivery === undefined ? "steer" : body.delivery
  const expectedTurnId = body.expectedTurnId === undefined || body.expectedTurnId === null ? null : stringValue(body.expectedTurnId)
  const expectedRevision = optionalRevision(body.expectedRevision)
  const content = parseContent(body.content)
  if (!clientMessageId || (delivery !== "steer" && delivery !== "follow_up") || (body.expectedTurnId !== undefined && body.expectedTurnId !== null && expectedTurnId === null) || expectedRevision === undefined || !content) {
    return invalid("Invalid message command payload")
  }
  const protocolCommand = {
    schemaVersion: body.schemaVersion ?? schemaVersion,
    clientMessageId,
    sessionId,
    expectedTurnId,
    delivery,
    content,
  }
  if (!validateProtocolCommand(protocolCommand)) return invalid("Message command failed protocol validation")
  return { clientMessageId, delivery, expectedTurnId, expectedRevision, content }
}

export function parseInterruptBody(body: unknown, request: Request): ParsedInterruptCommand | NextResponse {
  if (!isRecord(body) || !isAllowedKeys(body, ["clientMessageId", "expectedRevision", "schemaVersion"])) {
    return invalid("Unsupported or forbidden interrupt field")
  }
  if (body.schemaVersion !== undefined && body.schemaVersion !== schemaVersion) return invalid("Unsupported command schema version")
  const clientMessageId = commandId(body, request)
  const expectedRevision = optionalRevision(body.expectedRevision)
  if (!clientMessageId || expectedRevision === undefined) return invalid("Invalid interrupt command payload")
  return { clientMessageId, expectedRevision }
}

export async function verifyAttachmentOwnership(
  db: PrismaClient,
  userId: string,
  content: InputContentPart[],
): Promise<NextResponse | null> {
  const attachmentIds = content.filter((part) => part.type === "attachment_ref").map((part) => part.attachmentId)
  if (attachmentIds.length === 0) return null
  const owned = await db.resume.findMany({ where: { id: { in: attachmentIds }, userId }, select: { id: true } })
  if (owned.length !== new Set(attachmentIds).size) return invalid("Attachment is not owned by the authenticated user", "attachment_not_owned")
  return null
}

export function commandErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentCommandError) {
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status })
  }
  return NextResponse.json({ error: { code: "internal_error", message: "Could not accept the agent command", details: {} } }, { status: 500 })
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}
