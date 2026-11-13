import { schemaVersion } from "@jobcopilot/agent-protocol"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import type { ObjectiveVerificationRequirements } from "@/lib/agent/control-plane/commands/types"

export interface ObjectiveContextDraft {
  readonly objective: string
  readonly context: string
}

export interface ObjectiveStartResult {
  readonly sessionId: string
  readonly objective: string
  readonly inputId: string
  readonly turnId: string
  readonly disposition: "started" | "duplicate"
  readonly sequence: string
}

interface ObjectiveStartAttempt extends ObjectiveContextDraft {
  readonly objectiveDraft: string
  readonly contextDraft: string
  readonly allowedLocationsDraft: string
  readonly requirementsDraftKey: string
  readonly verificationRequirements?: ObjectiveVerificationRequirements
  readonly clientMessageId: string
}

export class ObjectiveStartCommandError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = "ObjectiveStartCommandError"
    this.status = status
    this.code = code
    this.details = details
  }
}

const MAX_OBJECTIVE_BYTES = 2_000
const MAX_CONTEXT_CHARACTERS = 20_000
const MAX_IDENTIFIER_LENGTH = 256
const MAX_LOCATION_DRAFT_BYTES = 2_000
const LOCATION_REQUIREMENTS_SCHEMA_VERSION = "agent-harness.v2.objective-requirements.v2" as const
const LOCATION_REQUIREMENT_ID = "candidate-location"

export function validateObjectiveContextDraft(draft: ObjectiveContextDraft): ObjectiveContextDraft {
  const objective = typeof draft.objective === "string" ? draft.objective.trim() : ""
  const context = typeof draft.context === "string" ? draft.context : ""
  if (!objective || new TextEncoder().encode(objective).byteLength > MAX_OBJECTIVE_BYTES) {
    throw invalidInput("Objective must contain 1 to 2,000 UTF-8 bytes")
  }
  if (context.length > MAX_CONTEXT_CHARACTERS) {
    throw invalidInput("Background context must be 20,000 characters or fewer")
  }
  return { objective, context }
}

export function normalizeAllowedLocationDraft(value: string): readonly string[] | undefined {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_LOCATION_DRAFT_BYTES) {
    throw invalidInput("Allowed locations must be 2,000 UTF-8 bytes or fewer")
  }
  if (value.trim() === "") return undefined
  const entries = value.split(/\r?\n/).filter(entry => entry.trim() !== "")
  const locations = normalizeAgentLocationAllowlist(entries)
  if (!locations) throw invalidInput("Enter 1 to 8 allowed locations, each 128 UTF-8 bytes or fewer")
  return locations
}

/** Coordinates explicit retries without creating a second Session or root. */
export class AgentObjectiveStartCoordinator {
  private sessionId: string | null = null
  private attempt: ObjectiveStartAttempt | null = null
  private inFlight: Promise<ObjectiveStartResult> | null = null
  private accepted: ObjectiveStartResult | null = null

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly makeClientMessageId: () => string = newClientMessageId,
  ) {}

  start(
    objectiveDraft: string,
    contextDraft: string,
    allowedLocationsDraft = "",
    existingRequirements?: ObjectiveVerificationRequirements,
  ): Promise<ObjectiveStartResult> {
    if (this.inFlight) return this.inFlight
    if (this.accepted) return Promise.resolve(this.accepted)

    let draft: ObjectiveContextDraft
    try {
      draft = validateObjectiveContextDraft({ objective: objectiveDraft, context: contextDraft })
    } catch (error) {
      return Promise.reject(error)
    }

    let verificationRequirements: ObjectiveVerificationRequirements | undefined
    let requirementsDraftKey: string
    try {
      requirementsDraftKey = JSON.stringify(existingRequirements ?? null) ?? ""
      if (new TextEncoder().encode(requirementsDraftKey).byteLength > MAX_LOCATION_DRAFT_BYTES) {
        throw invalidInput("Objective verification requirements exceed the command limit")
      }
      const locations = normalizeAllowedLocationDraft(allowedLocationsDraft)
      if (locations) {
        const existing = existingRequirements?.requirements ?? []
        if (existing.some(requirement => requirement.id === LOCATION_REQUIREMENT_ID)) {
          throw invalidInput("The candidate-location criterion ID is already in use")
        }
        verificationRequirements = {
          schemaVersion: LOCATION_REQUIREMENTS_SCHEMA_VERSION,
          requirements: [
            ...existing,
            { id: LOCATION_REQUIREMENT_ID, check: { kind: "candidate_location_in", locations } },
          ],
        }
      } else {
        verificationRequirements = existingRequirements
      }
    } catch (error) {
      return Promise.reject(error)
    }

    if (!this.attempt || this.attempt.objectiveDraft !== objectiveDraft || this.attempt.contextDraft !== contextDraft ||
        this.attempt.allowedLocationsDraft !== allowedLocationsDraft || this.attempt.requirementsDraftKey !== requirementsDraftKey) {
      this.attempt = {
        ...draft, objectiveDraft, contextDraft, allowedLocationsDraft, requirementsDraftKey,
        ...(verificationRequirements ? { verificationRequirements } : {}),
        clientMessageId: this.makeClientMessageId(),
      }
    }
    const attempt = this.attempt
    const operation = this.admit(attempt)
    this.inFlight = operation
    void operation.then(
      () => { if (this.inFlight === operation) this.inFlight = null },
      () => { if (this.inFlight === operation) this.inFlight = null },
    )
    return operation
  }

  draftEdited(): void {
    if (this.inFlight || this.accepted) return
    this.attempt = null
  }

  discard(): void {
    if (this.inFlight) return
    this.sessionId = null
    this.attempt = null
    this.accepted = null
  }

  private async admit(attempt: ObjectiveStartAttempt): Promise<ObjectiveStartResult> {
    if (!this.sessionId) this.sessionId = await createObjectiveSession(attempt.objective, this.fetcher)
    const sessionId = this.sessionId
    if (!sessionId) throw new ObjectiveStartCommandError(502, "invalid_session_response", "Session creation returned no usable Session ID")
    const result = await startAgentObjective(sessionId, attempt, this.fetcher)
    this.accepted = { ...result, sessionId, objective: attempt.objective }
    return this.accepted
  }
}

async function createObjectiveSession(objective: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher("/api/agent/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: objective }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw responseError(response.status, body, "Session creation failed")
  const root = record(body) ? body : {}
  const session = record(root.session) ? root.session : {}
  const sessionId = session.id
  if (!isIdentifier(sessionId)) {
    throw new ObjectiveStartCommandError(502, "invalid_session_response", "Session creation returned no usable Session ID")
  }
  return sessionId
}

async function startAgentObjective(
  sessionId: string,
  attempt: ObjectiveStartAttempt,
  fetcher: typeof fetch,
): Promise<Omit<ObjectiveStartResult, "sessionId" | "objective">> {
  const contentText = attempt.context === "" ? attempt.objective : attempt.context
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(sessionId)}/start-objective`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.clientMessageId },
    body: JSON.stringify({
      schemaVersion,
      clientMessageId: attempt.clientMessageId,
      objective: attempt.objective,
      content: [{ type: "text", text: contentText }],
      ...(attempt.verificationRequirements ? { verificationRequirements: attempt.verificationRequirements } : {}),
    }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw responseError(response.status, body, "Objective start failed")
  if (!record(body) || !isNonemptyString(body.inputId) || !isNonemptyString(body.turnId)
    || typeof body.sequence !== "string" || (body.disposition !== "started" && body.disposition !== "duplicate")) {
    throw new ObjectiveStartCommandError(502, "invalid_start_response", "Objective start returned an invalid response")
  }
  return {
    inputId: body.inputId,
    turnId: body.turnId,
    disposition: body.disposition,
    sequence: body.sequence,
  }
}

function responseError(status: number, value: unknown, fallback: string): ObjectiveStartCommandError {
  const root = record(value) ? value : {}
  const error = record(root.error) ? root.error : {}
  return new ObjectiveStartCommandError(
    status,
    isNonemptyString(error.code) ? error.code : "command_failed",
    isNonemptyString(error.message) ? error.message : `${fallback} (${status})`,
    record(error.details) ? error.details : {},
  )
}

function invalidInput(message: string): ObjectiveStartCommandError {
  return new ObjectiveStartCommandError(422, "invalid_command", message)
}

function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `objective-start-${crypto.randomUUID()}`
  return `objective-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isIdentifier(value: unknown): value is string {
  return isNonemptyString(value) && value.length <= MAX_IDENTIFIER_LENGTH && value.trim() === value
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
