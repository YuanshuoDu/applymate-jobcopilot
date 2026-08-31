import {
  createLegacyModelFacade,
  type LegacyModelFacade,
  type ModelAdapter,
  type ModelCapabilityProfile,
} from "@jobcopilot/agent-model"
import { callLlm, type AiConfig } from "@jobcopilot/shared"

const WORKER_CAPABILITY_FLAGS = {
  nativeTools: false,
  structuredOutput: false,
  streaming: false,
  continuationCursor: false,
  supportsParallelTools: false,
  supportsStreamingToolArgs: false,
  supportsReasoningSummary: false,
  supportsResponseContinuation: false,
  supportsProviderConversation: false,
  supportsBackgroundResponse: false,
} as const

export const workerAgentModel: LegacyModelFacade<AiConfig> = createLegacyModelFacade<AiConfig>({
  chat: (messages, config, _maxTokens, usageContext) => callLlm(messages, config, usageContext),
}, { runtime: "worker" })

export function workerModelCapabilityProfile(config: Pick<AiConfig, "provider" | "model">): ModelCapabilityProfile {
  return {
    provider: config.provider,
    model: config.model,
    ...WORKER_CAPABILITY_FLAGS,
    maxContextTokens: null,
    maxOutputTokens: null,
    costClass: "unknown",
  }
}

export function createWorkerModelAdapter(config: AiConfig): ModelAdapter {
  const profile = workerModelCapabilityProfile(config)
  return workerAgentModel.createAdapter(config, profile, `worker:${config.provider}:${config.model}`)
}
