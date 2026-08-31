export type ModelErrorCode =
  | "adapter_not_found"
  | "invalid_request"
  | "unsupported_capability"
  | "unsupported_input"
  | "configuration_error"
  | "provider_error"
  | "malformed_response"
  | "timeout"
  | "cancelled"
  | "cursor_lost"

export interface ModelErrorInit {
  code: ModelErrorCode
  message: string
  provider?: string
  model?: string
  retryable?: boolean
  recoverable?: boolean
  retryAfterMs?: number
}

export interface ModelErrorDescriptor {
  code: ModelErrorCode
  message: string
  provider?: string
  model?: string
  retryable: boolean
  recoverable: boolean
  retryAfterMs?: number
}

export class AgentModelError extends Error {
  readonly code: ModelErrorCode
  readonly provider?: string
  readonly model?: string
  readonly retryable: boolean
  readonly recoverable: boolean
  readonly retryAfterMs?: number

  constructor(init: ModelErrorInit) {
    super(init.message)
    this.name = "AgentModelError"
    this.code = init.code
    this.provider = init.provider
    this.model = init.model
    this.retryable = init.retryable ?? false
    this.recoverable = init.recoverable ?? false
    this.retryAfterMs = init.retryAfterMs
  }

  descriptor(): ModelErrorDescriptor {
    return {
      code: this.code,
      message: this.message,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
      retryable: this.retryable,
      recoverable: this.recoverable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

export function isAgentModelError(error: unknown): error is AgentModelError {
  return error instanceof AgentModelError
}

export function cancellationError(request: { provider?: string; model?: string }): AgentModelError {
  return new AgentModelError({
    code: "cancelled",
    message: "Model call cancelled",
    provider: request.provider,
    model: request.model,
    recoverable: true,
  })
}
