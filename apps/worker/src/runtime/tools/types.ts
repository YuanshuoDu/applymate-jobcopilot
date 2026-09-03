import type { TSchema } from "@sinclair/typebox"
import {
  schemaVersion,
  type RepositoryJsonValue,
  type PolicyDomain,
  type PolicyRole,
  type ToolRisk as ProtocolToolRisk,
  type TenantScope,
  type ToolCapability,
  type ToolDefinition,
} from "@jobcopilot/agent-protocol"

export type ToolRisk = ProtocolToolRisk
export type ToolDomain = PolicyDomain
export type ToolIdempotency = "read_only" | "idempotent" | "requires_key" | "non_repeatable"

export interface ToolExecutionContext {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly toolCallId?: string
  /** Runtime-owned task lineage; never accepted from model tool input. */
  readonly taskId?: string
  readonly rootTaskId?: string
  readonly actorRole?: PolicyRole
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
  readonly domain: ToolDomain
  readonly idempotency: ToolIdempotency
  readonly timeoutMs: number
  readonly requiredCapabilities: readonly string[]
  readonly execute: (context: ToolExecutionContext, input: TInput) => Promise<TOutput>
}

export type PublicToolDefinition = Omit<ToolDefinition, "inputSchema" | "outputSchema"> & {
  inputSchema: TSchema
  outputSchema: TSchema
  risk: ToolRisk
  domain: ToolDomain
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
  /** Runtime-owned task lineage; never accepted from model tool input. */
  readonly taskId?: string
  readonly rootTaskId?: string
  readonly signal?: AbortSignal
  readonly capabilities?: readonly string[]
  /** Runtime-owned actor role; the model cannot supply or override this value. */
  readonly actorRole?: PolicyRole
}

export class ToolExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ToolExecutionError"
  }
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
