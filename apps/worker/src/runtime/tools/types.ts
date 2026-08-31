import type { TSchema } from "@sinclair/typebox"
import {
  schemaVersion,
  type RepositoryJsonValue,
  type TenantScope,
  type ToolCapability,
  type ToolDefinition,
} from "@jobcopilot/agent-protocol"

export type ToolRisk = "read" | "draft_write" | "internal_write" | "external_write"
export type ToolIdempotency = "read_only" | "idempotent" | "requires_key" | "non_repeatable"

export interface ToolExecutionContext {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly signal: AbortSignal
  readonly capabilities: readonly string[]
  reportProgress(progress: unknown): Promise<void>
}

export interface RuntimeToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly schemaVersion: typeof schemaVersion
  readonly name: string
  readonly version: string
  readonly description: string
  readonly capabilities: readonly ToolCapability[]
  readonly inputSchema: TSchema
  readonly outputSchema: TSchema
  readonly risk: ToolRisk
  readonly idempotency: ToolIdempotency
  readonly timeoutMs: number
  readonly requiredCapabilities: readonly string[]
  readonly execute: (context: ToolExecutionContext, input: TInput) => Promise<TOutput>
}

export type PublicToolDefinition = Omit<ToolDefinition, "inputSchema" | "outputSchema"> & {
  inputSchema: TSchema
  outputSchema: TSchema
  risk: ToolRisk
  idempotency: ToolIdempotency
  timeoutMs: number
  requiredCapabilities: readonly string[]
}

export interface ToolCallRequest {
  readonly id: string
  readonly toolName: string
  readonly toolVersion: string
  readonly input: unknown
}

export interface ToolRouterContext {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly signal?: AbortSignal
  readonly capabilities?: readonly string[]
}

export interface ToolExecutionResult {
  readonly id: string
  readonly toolName: string
  readonly toolVersion: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly errorCode: string | null
}

export interface ToolLifecyclePayload {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolVersion: string
  readonly status: string
  readonly [key: string]: RepositoryJsonValue
}
