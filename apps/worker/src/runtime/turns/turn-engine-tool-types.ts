export type TurnEngineToolCall = {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

export type TurnEngineToolResult = {
  readonly id: string
  readonly toolName: string
  readonly toolVersion: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly errorCode: string | null
}

export type PersistedToolCallRecovery = {
  readonly call: TurnEngineToolCall
  readonly toolVersion: string
  readonly stepId: string
  readonly callItem: { readonly id: string; readonly revision: number }
  readonly resultItem?: { readonly id: string; readonly revision: number }
  readonly durableResult?: TurnEngineToolResult
}

export type ToolCallRecovery = PersistedToolCallRecovery & {
  readonly action: "replay" | "reconcile" | "fail" | "terminal"
}