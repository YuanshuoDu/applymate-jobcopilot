export type AgentCommandErrorCode =
  | "agent_session_not_found"
  | "active_turn_changed"
  | "automation_cannot_steer_user_turn"
  | "invalid_command"
  | "turn_not_active"
  | "fork_boundary_not_found"
  | "fork_boundary_active"
  | "fork_idempotency_conflict"

export class AgentCommandError extends Error {
  readonly status: 404 | 409 | 422
  readonly code: AgentCommandErrorCode
  readonly details: Readonly<Record<string, string | number | null>>

  constructor(
    code: AgentCommandErrorCode,
    message: string,
    status: 404 | 409 | 422,
    details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message)
    this.name = "AgentCommandError"
    this.code = code
    this.status = status
    this.details = details
  }
}

export function sessionNotFound(sessionId: string): AgentCommandError {
  return new AgentCommandError(
    "agent_session_not_found",
    `Agent session ${sessionId} does not exist for this user`,
    404,
    { sessionId },
  )
}

export function activeTurnChanged(expectedTurnId: string | null, actualTurnId: string | null): AgentCommandError {
  return new AgentCommandError(
    "active_turn_changed",
    "The active Agent Turn changed before this command was accepted",
    409,
    { expectedTurnId, actualTurnId },
  )
}

export function automationCannotSteerUserTurn(turnId: string): AgentCommandError {
  return new AgentCommandError(
    "automation_cannot_steer_user_turn",
    "Automation commands cannot steer a user-owned active Turn",
    409,
    { turnId },
  )
}

export function invalidCommand(message: string): AgentCommandError {
  return new AgentCommandError("invalid_command", message, 422)
}

export function turnNotActive(turnId: string | null): AgentCommandError {
  return new AgentCommandError(
    "turn_not_active",
    "The requested Agent Turn is not active",
    409,
    { turnId },
  )
}

export function forkBoundaryNotFound(turnId: string): AgentCommandError {
  return new AgentCommandError("fork_boundary_not_found", `Turn ${turnId} is not in the source session`, 409, { turnId })
}

export function forkBoundaryActive(turnId: string): AgentCommandError {
  return new AgentCommandError("fork_boundary_active", "Fork boundary must be a terminal Turn", 409, { turnId })
}

export function forkIdempotencyConflict(): AgentCommandError {
  return new AgentCommandError("fork_idempotency_conflict", "The idempotency key was already used for a different fork", 409)
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as { code?: unknown }).code === "P2002"
}
