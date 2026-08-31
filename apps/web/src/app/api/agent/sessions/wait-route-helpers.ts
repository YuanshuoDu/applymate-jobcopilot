import { NextResponse } from "next/server"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { AgentWaitError } from "@/lib/agent/broker/errors"

type Body = Record<string, unknown>

function record(value: unknown): Body | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Body : null
}

function text(value: unknown, max = 256): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized && normalized.length <= max ? normalized : null
}

function revision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function commandId(body: Body, request: Request): string | null {
  const bodyId = body.clientMessageId === undefined ? null : text(body.clientMessageId)
  const headerId = text(request.headers.get("idempotency-key"))
  if (body.clientMessageId !== undefined && !bodyId) return null
  if (bodyId && headerId && bodyId !== headerId) return null
  return bodyId ?? headerId
}

function invalid(message: string) {
  return NextResponse.json({ error: { code: "wait_invalid_command", message, details: {} } }, { status: 422 })
}

function allowed(body: Body, keys: readonly string[]) {
  return Object.keys(body).every((key) => keys.includes(key))
}

export type ApprovalDecisionCommand = {
  clientMessageId: string
  expectedTurnId: string
  expectedRevision: number
  decision: "approved" | "rejected"
}

export type QuestionAnswerCommand = {
  clientMessageId: string
  expectedTurnId: string
  expectedRevision: number
  answer: string
}

export function parseApprovalDecision(bodyValue: unknown, request: Request): ApprovalDecisionCommand | NextResponse {
  const body = record(bodyValue)
  if (!body || !allowed(body, ["schemaVersion", "clientMessageId", "expectedTurnId", "expectedRevision", "decision"])) {
    return invalid("Unsupported or forbidden approval decision field")
  }
  if (body.schemaVersion !== undefined && body.schemaVersion !== schemaVersion) return invalid("Unsupported command schema version")
  const clientMessageId = commandId(body, request)
  const expectedTurnId = text(body.expectedTurnId)
  const expectedRevision = revision(body.expectedRevision)
  if (!clientMessageId || !expectedTurnId || expectedRevision === null || (body.decision !== "approved" && body.decision !== "rejected")) {
    return invalid("Approval decision requires a command id, expected Turn revision, and decision")
  }
  return { clientMessageId, expectedTurnId, expectedRevision, decision: body.decision }
}

export function parseQuestionAnswer(bodyValue: unknown, request: Request): QuestionAnswerCommand | NextResponse {
  const body = record(bodyValue)
  if (!body || !allowed(body, ["schemaVersion", "clientMessageId", "expectedTurnId", "expectedRevision", "answer"])) {
    return invalid("Unsupported or forbidden question answer field")
  }
  if (body.schemaVersion !== undefined && body.schemaVersion !== schemaVersion) return invalid("Unsupported command schema version")
  const clientMessageId = commandId(body, request)
  const expectedTurnId = text(body.expectedTurnId)
  const expectedRevision = revision(body.expectedRevision)
  const answer = text(body.answer, 20_000)
  if (!clientMessageId || !expectedTurnId || expectedRevision === null || !answer) {
    return invalid("Question answer requires a command id, expected Turn revision, and non-empty answer")
  }
  return { clientMessageId, expectedTurnId, expectedRevision, answer }
}

export function waitErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentWaitError) {
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status })
  }
  return NextResponse.json({ error: { code: "internal_error", message: "Could not resolve the Agent wait", details: {} } }, { status: 500 })
}
