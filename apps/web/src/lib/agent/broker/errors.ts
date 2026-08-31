export type AgentWaitErrorCode =
  | "wait_not_found"
  | "wait_not_pending"
  | "wait_scope_mismatch"
  | "wait_revision_mismatch"
  | "wait_expired"
  | "wait_invalid_answer"
  | "wait_invalid_command"

export class AgentWaitError extends Error {
  readonly status: 404 | 409 | 422

  constructor(
    readonly code: AgentWaitErrorCode,
    message: string,
    status: 404 | 409 | 422,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message)
    this.name = "AgentWaitError"
    this.status = status
  }
}

export function waitNotFound(): AgentWaitError {
  return new AgentWaitError("wait_not_found", "The requested Agent wait was not found", 404)
}

export function waitNotPending(): AgentWaitError {
  return new AgentWaitError("wait_not_pending", "The requested Agent wait is no longer pending", 409)
}

export function waitScopeMismatch(): AgentWaitError {
  return new AgentWaitError("wait_scope_mismatch", "The Agent wait is not owned by this session", 409)
}

export function waitRevisionMismatch(expected: number, actual: number): AgentWaitError {
  return new AgentWaitError("wait_revision_mismatch", "The Agent wait revision is stale", 409, { expected, actual })
}

export function waitExpired(): AgentWaitError {
  return new AgentWaitError("wait_expired", "The Agent wait has expired", 409)
}

export function invalidAnswer(message: string): AgentWaitError {
  return new AgentWaitError("wait_invalid_answer", message, 422)
}

export function invalidWaitCommand(message: string): AgentWaitError {
  return new AgentWaitError("wait_invalid_command", message, 422)
}
