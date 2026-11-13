import { schemaVersion } from "@jobcopilot/agent-protocol"

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

/** Reuses the known Session and request identity for explicit in-memory retries. */
export class AgentObjectiveStartCoordinator {
  private sessionId: string | null = null
  private targetKey: string | null = null
  private attempt: ObjectiveStartAttempt | null = null
  private attemptIdentityKey: string | null = null
  private inFlight: Promise<ObjectiveStartResult> | null = null
  private inFlightIdentityKey: string | null = null
  private accepted: { readonly identityKey: string; readonly result: ObjectiveStartResult } | null = null

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly makeClientMessageId: () => string = newClientMessageId,
  ) {}

  start(objectiveDraft: string, contextDraft: string, selectedSessionId?: string): Promise<ObjectiveStartResult> {
    if (selectedSessionId !== undefined && !isIdentifier(selectedSessionId)) {
      return Promise.reject(invalidInput("Selected Session ID is invalid"))
    }
    let draft: ObjectiveContextDraft
    try {
      draft = validateObjectiveContextDraft({ objective: objectiveDraft, context: contextDraft })
    } catch (error) {
      return Promise.reject(error)
    }

    const targetKey = selectedSessionId === undefined || (this.targetKey === "new-session" && selectedSessionId === this.sessionId)
      ? "new-session" : `session:${selectedSessionId}`
    const identityKey = objectiveStartIdentity(targetKey, draft)
    if (this.inFlight) {
      if (this.inFlightIdentityKey === identityKey) return this.inFlight
      return Promise.reject(new ObjectiveStartCommandError(
        409, "objective_start_in_progress", "An objective start is already in progress for a different task or Session",
      ))
    }
    if (this.targetKey !== targetKey) {
      this.targetKey = targetKey
      this.sessionId = selectedSessionId ?? null
      this.attempt = null
      this.attemptIdentityKey = null
      this.accepted = null
    }
    if (this.accepted?.identityKey === identityKey) return Promise.resolve(this.accepted.result)
    this.accepted = null

    if (!this.attempt || this.attemptIdentityKey !== identityKey) {
      this.attempt = { ...draft, clientMessageId: this.makeClientMessageId() }
      this.attemptIdentityKey = identityKey
    }
    const attempt = this.attempt
    const operation = this.admit(attempt, identityKey)
    this.inFlight = operation
    this.inFlightIdentityKey = identityKey
    void operation.then(
      () => {
        if (this.inFlight === operation) {
          this.inFlight = null
          this.inFlightIdentityKey = null
        }
      },
      () => {
        if (this.inFlight === operation) {
          this.inFlight = null
          this.inFlightIdentityKey = null
        }
      },
    )
    return operation
  }

  draftEdited(): void {
    // The normalized payload passed to start() determines whether this is a new attempt.
  }

  discard(): void {
    if (this.inFlight) return
    this.sessionId = null
    this.targetKey = null
    this.attempt = null
    this.attemptIdentityKey = null
    this.inFlightIdentityKey = null
    this.accepted = null
  }

  private async admit(attempt: ObjectiveStartAttempt, identityKey: string): Promise<ObjectiveStartResult> {
    if (!this.sessionId) this.sessionId = await createObjectiveSession(attempt, this.fetcher)
    const sessionId = this.sessionId
    if (!sessionId) throw new ObjectiveStartCommandError(502, "invalid_session_response", "Session creation returned no usable Session ID")
    const result = await startAgentObjective(sessionId, attempt, this.fetcher)
    const accepted = { ...result, sessionId, objective: attempt.objective }
    this.accepted = { identityKey, result: accepted }
    return accepted
  }
}

function objectiveStartIdentity(targetKey: string, draft: ObjectiveContextDraft): string {
  return JSON.stringify([targetKey, draft.objective, draft.context])
}

async function createObjectiveSession(attempt: ObjectiveStartAttempt, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher("/api/agent/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.clientMessageId },
    body: JSON.stringify({ goal: attempt.objective }),
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
