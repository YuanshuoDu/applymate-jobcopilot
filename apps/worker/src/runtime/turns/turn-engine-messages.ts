import type { HarnessModelRequest, ModelMessage } from "@jobcopilot/agent-model"
import type { ModelCapabilityProfile, ModelAdapter } from "@jobcopilot/agent-model"

import type { StepContext } from "../context/step-context-builder.js"

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function blockText(block: StepContext["blocks"][number]): string {
  const trust = block.trust === "external_untrusted" ? "UNTRUSTED_DATA" : block.trust
  return `[harness context layer=${block.layer} trust=${trust} source=${block.source}]\n${stableJson(block.content)}`
}

export function contextToModelMessages(context: StepContext): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const block of context.blocks) {
    messages.push({
      role: block.role === "instruction" ? "system" : "user",
      content: [{ type: "text", text: blockText(block) }],
    })
  }
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "Continue the Turn according to the harness contract." }] })
  return messages
}

function capabilities(profile: ModelCapabilityProfile) {
  return {
    nativeTools: profile.nativeTools,
    structuredOutput: profile.structuredOutput,
    streaming: profile.streaming,
    continuationCursor: profile.continuationCursor,
  }
}

export function buildModelRequest(input: {
  context: StepContext
  model: ModelAdapter
  tools: readonly unknown[]
  sessionId: string
  turnId: string
  stepId: string
  userId: string
  taskId: string
  signal: AbortSignal
  maxOutputTokens?: number
}): HarnessModelRequest {
  return {
    schemaVersion: "agent-harness.v2",
    provider: input.model.profile.provider,
    model: input.model.profile.model,
    messages: contextToModelMessages(input.context),
    tools: [...input.tools],
    capabilities: capabilities(input.model.profile),
    ...(input.model.profile.nativeTools && input.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    signal: input.signal,
    metadata: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      taskId: input.taskId,
      userId: input.userId,
      featureId: "agent-harness.turn",
      traceId: `${input.turnId}:${input.stepId}`,
    },
  }
}
