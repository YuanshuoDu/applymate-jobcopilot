export class AgentRepositoryConflictError extends Error {
  readonly code = "agent_repository_conflict"

  constructor(message: string) {
    super(message)
    this.name = "AgentRepositoryConflictError"
  }
}

export class AgentRepositoryJsonError extends Error {
  readonly code = "agent_repository_invalid_json"

  constructor(field: string) {
    super(`Agent repository returned invalid JSON in ${field}`)
    this.name = "AgentRepositoryJsonError"
  }
}
