import type {
  HarnessModelRequest,
  ModelAdapter,
  ModelCapabilityProfile,
  ModelStreamEvent,
} from "../../contracts.js"
import type { OpenAiFetch } from "../openai-compatible/types.js"

export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3"
export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1"
export const MINIMAX_DEFAULT_MAX_COMPLETION_TOKENS = 4_096

export type MiniMaxThinkingMode = "adaptive" | "disabled"

export interface MiniMaxConfig {
  provider?: "minimax"
  model?: string
  apiKey?: string
  /** Explicit platform-key seam for workers/tests; otherwise MINIMAX_API_KEY is used. */
  platformApiKey?: string
  baseUrl?: string
  /** Compatibility alias for the existing ModelRouter/shared AI config shape. */
  apiBase?: string
  thinking?: MiniMaxThinkingMode
  reasoningSplit?: boolean
  maxCompletionTokens?: number
  timeoutMs?: number
}

export interface MiniMaxAdapterOptions {
  /** Test seam; production callers use the built-in DNS-pinned transport. */
  fetch?: OpenAiFetch
  allowLocalDevelopment?: boolean
  timeoutMs?: number
  profile?: Partial<Omit<ModelCapabilityProfile, "provider" | "model">>
}

export interface MiniMaxAdapter extends ModelAdapter {
  readonly config: Readonly<Pick<MiniMaxConfig, "model" | "baseUrl">>
  readonly credentialSource: "platform" | "user"
  readonly reasoningSplit: boolean
  readonly thinking: MiniMaxThinkingMode
  stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent>
}

export interface MiniMaxCredentials {
  apiKey: string
  credentialSource: "platform" | "user"
}

export interface MiniMaxRequestOptions {
  model: string
  maxCompletionTokens: number
  reasoningSplit: boolean
  thinking: MiniMaxThinkingMode
}
