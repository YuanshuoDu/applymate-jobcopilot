export type AgentCommandErrorCode =
  | "agent_session_not_found"
  | "active_turn_changed"
  | "execution_changed"
  | "automation_cannot_steer_user_turn"
  | "invalid_command"
  | "turn_not_active"
  | "fork_boundary_not_found"
  | "fork_boundary_active"
  | "fork_idempotency_conflict"
  | "retry_target_invalid"
  | "retry_active_conflict"
  | "retry_target_changed"
  | "retry_input_invalid"
  | "agent_session_paused"
  | "session_pause_conflict"
  | "session_control_revision_changed"
  | "session_control_idempotency_conflict"

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

export function executionChanged(executionId: string): AgentCommandError {
  return new AgentCommandError(
    "execution_changed",
    "The Agent execution changed before cancellation was accepted",
    409,
    { executionId },
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

export function retryTargetInvalid(turnId: string, status: string | null = null): AgentCommandError {
  return new AgentCommandError("retry_target_invalid", "The requested Turn is not retryable", 409, { turnId, status })
}

export function retryActiveConflict(turnId: string): AgentCommandError {
  return new AgentCommandError("retry_active_conflict", "Another root Turn is already active in this session", 409, { turnId })
}

export function retryTargetChanged(turnId: string, expectedRevision: number, actualRevision: number): AgentCommandError {
  return new AgentCommandError("retry_target_changed", "The retry target changed before the command was accepted", 409, { turnId, expectedRevision, actualRevision })
}

export function retryInputInvalid(turnId: string): AgentCommandError {
  return new AgentCommandError("retry_input_invalid", "The retry target has no valid persisted user input", 409, { turnId })
}

export function sessionPaused(sessionId: string): AgentCommandError {
  return new AgentCommandError("agent_session_paused", "Agent session is paused by the user", 409, { sessionId })
}

export function sessionPauseConflict(turnId: string): AgentCommandError {
  return new AgentCommandError("session_pause_conflict", "The session has an active Turn and cannot be paused", 409, { turnId })
}

export function sessionControlRevisionChanged(expectedRevision: number, actualRevision: number): AgentCommandError {
  return new AgentCommandError("session_control_revision_changed", "The session control gate changed before this command was accepted", 409, { expectedRevision, actualRevision })
}

export function sessionControlIdempotencyConflict(): AgentCommandError {
  return new AgentCommandError("session_control_idempotency_conflict", "The idempotency key was already used for a different session control command", 409)
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as { code?: unknown }).code === "P2002"
}
