import {
  createLegacyModelFacade,
  type LegacyModelFacade,
  type ModelAdapter,
  type ModelCapabilityProfile,
} from "@jobcopilot/agent-model"
import { modelChat, modelChatStream, type AiConfig, type ChatMessage } from "./model-router"

const WEB_CAPABILITY_FLAGS = {
  nativeTools: false,
  structuredOutput: false,
  streaming: true,
  continuationCursor: false,
  supportsParallelTools: false,
  supportsStreamingToolArgs: false,
  supportsReasoningSummary: false,
  supportsResponseContinuation: false,
  supportsProviderConversation: false,
  supportsBackgroundResponse: false,
} as const

export const webAgentModel: LegacyModelFacade<AiConfig> = createLegacyModelFacade<AiConfig>({
  chat: (messages, config, maxTokens, usageContext) => modelChat(messages as ChatMessage[], config, maxTokens, usageContext),
  stream: (messages, config, maxTokens, usageContext) => modelChatStream(messages as ChatMessage[], config, maxTokens, usageContext),
}, { runtime: "web" })

export function webModelCapabilityProfile(config: Pick<AiConfig, "provider" | "model">): ModelCapabilityProfile {
  return {
    provider: config.provider,
    model: config.model,
    ...WEB_CAPABILITY_FLAGS,
    maxContextTokens: null,
    maxOutputTokens: null,
    costClass: "unknown",
  }
}

export function createWebModelAdapter(config: AiConfig): ModelAdapter {
  const profile = webModelCapabilityProfile(config)
  return webAgentModel.createAdapter(config, profile, `web:${config.provider}:${config.model}`)
}
