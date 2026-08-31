import type {
  HarnessModelRequest,
  ModelAdapter,
  ModelCapabilityProfile,
  ModelStreamEvent,
} from "../../contracts.js"

export type OpenAiWireMode = "chat_completions" | "responses"

export interface OpenAiCompatibleConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  mode?: OpenAiWireMode
  organization?: string
  timeoutMs?: number
}

export interface OpenAiCompatibleAdapterOptions {
  /** Test seam; production callers should use the built-in DNS-pinned fetch. */
  fetch?: OpenAiFetch
  mode?: OpenAiWireMode
  allowLocalDevelopment?: boolean
  timeoutMs?: number
  profile?: Partial<Omit<ModelCapabilityProfile, "provider" | "model">>
}

export interface OpenAiFetchInit {
  method: "POST"
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

export type OpenAiFetch = (url: string, init: OpenAiFetchInit) => Promise<Response>

export interface OpenAiRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  mode: OpenAiWireMode
}

export interface OpenAiParserResult {
  events: ModelStreamEvent[]
  terminal: boolean
}

export interface OpenAiEventParser {
  consume(eventName: string | undefined, data: unknown): OpenAiParserResult
  finish(): ModelStreamEvent[]
}

export interface OpenAiCompatibleAdapter extends ModelAdapter {
  readonly config: Readonly<Pick<OpenAiCompatibleConfig, "provider" | "model" | "baseUrl">>
  stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent>
}
