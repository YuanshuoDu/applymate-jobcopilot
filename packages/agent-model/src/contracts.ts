import {
  schemaVersion,
  type ModelCapabilities,
  type ModelMessage,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
} from "@jobcopilot/agent-protocol"

export const MODEL_SCHEMA_VERSION = schemaVersion

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error"
export type ModelToolChoice = "auto" | "none" | { name: string }
export type ModelCostClass = "low" | "medium" | "high" | "unknown"

export interface ModelCallMetadata {
  sessionId: string
  turnId: string
  stepId: string
  taskId: string
  userId?: string
  featureId?: string
  traceId?: string
}

export interface ModelContinuation {
  cursor?: string
  providerResponseId?: string
  providerConversationId?: string
}

export interface ModelCapabilityProfile extends ModelCapabilities {
  provider: string
  model: string
  supportsParallelTools: boolean
  supportsStreamingToolArgs: boolean
  supportsReasoningSummary: boolean
  supportsResponseContinuation: boolean
  supportsProviderConversation: boolean
  supportsBackgroundResponse: boolean
  maxContextTokens: number | null
  maxOutputTokens: number | null
  costClass: ModelCostClass
}

export type ModelCapabilityRequirement = Partial<Pick<
  ModelCapabilityProfile,
  | "nativeTools"
  | "structuredOutput"
  | "streaming"
  | "continuationCursor"
  | "supportsParallelTools"
  | "supportsStreamingToolArgs"
  | "supportsReasoningSummary"
  | "supportsResponseContinuation"
  | "supportsProviderConversation"
  | "supportsBackgroundResponse"
>>

export interface HarnessModelRequest {
  schemaVersion: typeof schemaVersion
  provider: string
  model: string
  messages: readonly ModelMessage[]
  tools: readonly unknown[]
  capabilities: ModelCapabilities
  outputSchema?: unknown
  toolChoice?: ModelToolChoice
  continuation?: ModelContinuation
  maxOutputTokens?: number
  signal: AbortSignal
  metadata: ModelCallMetadata
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "tool_call_started"; callId: string; name: string }
  | { type: "tool_arguments_delta"; callId: string; delta: string }
  | { type: "tool_call_completed"; callId: string; name: string; arguments: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; estimatedCostUsd?: number; provider?: string; model?: string }
  | { type: "continuation"; continuation: ModelContinuation }
  | { type: "completed"; finishReason: ModelFinishReason }

export interface ModelAdapter {
  readonly id: string
  readonly profile: ModelCapabilityProfile
  stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent>
  complete?(request: HarnessModelRequest): Promise<ModelResponse>
}

export type { ModelCapabilities, ModelMessage, ModelResponse, ModelToolCall, ModelUsage }
