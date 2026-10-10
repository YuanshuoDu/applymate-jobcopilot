import { schemaVersion } from "@jobcopilot/agent-protocol"

export interface ReplaceAgentObjectiveRequest {
  readonly sessionId: string
  readonly expectedTurnId: string
  readonly expectedRevision: number
  readonly clientMessageId: string
  readonly text: string
}

export interface ObjectiveReplacementResult {
  readonly inputId: string
  readonly turnId: string
  readonly disposition: "started" | "duplicate"
  readonly sequence: string
  readonly originalDisposition?: "started" | "steered" | "queued_follow_up"
}

export class ObjectiveReplacementCommandError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = "ObjectiveReplacementCommandError"
    this.status = status
    this.code = code
    this.details = details
  }
}

const MAX_IDENTIFIER_LENGTH = 256
const MAX_OBJECTIVE_BYTES = 2_000

export async function replaceAgentObjective(
  request: ReplaceAgentObjectiveRequest,
  fetcher: typeof fetch = fetch,
): Promise<ObjectiveReplacementResult> {
  const text = validatedText(request.text)
  validateIdentifier(request.sessionId, "Session ID")
  validateIdentifier(request.expectedTurnId, "Turn ID")
  validateIdentifier(request.clientMessageId, "Client message ID")
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw invalidInput("A valid expected Turn revision is required")
  }

  const response = await fetcher(
    "/api/agent/sessions/" + encodeURIComponent(request.sessionId) + "/replace-objective",
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": request.clientMessageId },
      body: JSON.stringify({
        schemaVersion,
        clientMessageId: request.clientMessageId,
        expectedTurnId: request.expectedTurnId,
        expectedRevision: request.expectedRevision,
        content: [{ type: "text", text }],
      }),
    },
  )
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw commandError(response.status, body)
  return parseResult(body)
}

function validatedText(value: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_OBJECTIVE_BYTES) {
    throw invalidInput("Objective text must contain 1 to 2,000 UTF-8 bytes")
  }
  return text
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || value.trim() !== value) {
    throw invalidInput(label + " is invalid")
  }
}

function invalidInput(message: string): ObjectiveReplacementCommandError {
  return new ObjectiveReplacementCommandError(422, "invalid_command", message)
}

function commandError(status: number, value: unknown): ObjectiveReplacementCommandError {
  const root = record(value) ? value : {}
  const error = record(root.error) ? root.error : {}
  const code = isNonemptyString(error.code) ? error.code : "command_failed"
  const message = isNonemptyString(error.message) ? error.message : "Objective replacement failed (" + status + ")"
  const details = record(error.details) ? error.details : {}
  return new ObjectiveReplacementCommandError(status, code, message, details)
}

function parseResult(value: unknown): ObjectiveReplacementResult {
  if (!record(value)
    || !isNonemptyString(value.inputId)
    || !isNonemptyString(value.turnId)
    || typeof value.sequence !== "string"
    || (value.disposition !== "started" && value.disposition !== "duplicate")) {
    throw new Error("Objective replacement returned an invalid response")
  }
  const original = value.originalDisposition
  if (original !== undefined && original !== "started" && original !== "steered" && original !== "queued_follow_up") {
    throw new Error("Objective replacement returned an invalid original disposition")
  }
  return {
    inputId: value.inputId,
    turnId: value.turnId,
    disposition: value.disposition,
    sequence: value.sequence,
    ...(original === undefined ? {} : { originalDisposition: original }),
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}