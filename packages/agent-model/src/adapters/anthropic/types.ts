import type {
  HarnessModelRequest,
  ModelAdapter,
  ModelCapabilityProfile,
  ModelStreamEvent,
} from "../../contracts.js"

export interface AnthropicConfig {
  provider: string
  model: string
  apiKey: string
  baseUrl?: string
  anthropicVersion?: string
  timeoutMs?: number
}

export interface AnthropicAdapterOptions {
  /** Test seam; production callers use the built-in DNS-pinned transport. */
  fetch?: AnthropicFetch
  allowLocalDevelopment?: boolean
  timeoutMs?: number
  profile?: Partial<Omit<ModelCapabilityProfile, "provider" | "model">>
}

export interface AnthropicFetchInit {
  method: "POST"
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

export type AnthropicFetch = (url: string, init: AnthropicFetchInit) => Promise<Response>

export interface AnthropicRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  toolNameMap: ReadonlyMap<string, string>
}

export interface AnthropicEventParser {
  consume(eventName: string | undefined, data: unknown): {
    events: ModelStreamEvent[]
    terminal: boolean
  }
  finish(): ModelStreamEvent[]
}

export interface AnthropicAdapter extends ModelAdapter {
  readonly config: Readonly<Pick<AnthropicConfig, "provider" | "model" | "baseUrl">>
  stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent>
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | AnthropicTextBlock[]
  is_error?: boolean
}
