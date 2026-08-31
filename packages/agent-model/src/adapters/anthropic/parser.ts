import { AgentModelError } from "../../errors.js"
import type { ModelFinishReason, ModelStreamEvent } from "../../contracts.js"
import { ToolCallAccumulator } from "../openai-compatible/tool-aggregation.js"
import type { AnthropicEventParser } from "./types.js"

type RecordValue = Record<string, unknown>
type BlockKind = "text" | "tool_use" | "thinking" | "ignored"

export class AnthropicMessagesParser implements AnthropicEventParser {
  private readonly tools = new ToolCallAccumulator()
  private readonly blockKinds = new Map<number, BlockKind>()
  private readonly toolNameMap: ReadonlyMap<string, string>
  private finishReason: ModelFinishReason | undefined
  private inputTokens: number | undefined
  private outputTokens: number | undefined
  private usageEmitted = false
  private terminal = false

  constructor(toolNameMap: ReadonlyMap<string, string> = new Map()) {
    this.toolNameMap = toolNameMap
  }

  consume(eventName: string | undefined, data: unknown): { events: ModelStreamEvent[]; terminal: boolean } {
    if (this.terminal) return { events: [], terminal: true }
    const record = asRecord(data, "Anthropic stream event")
    const type = eventName ?? stringValue(record.type)
    if (type === "error" || record.error !== undefined) throw providerError("Anthropic provider returned a stream error")
    if (type === "ping") return { events: [], terminal: false }
    if (type === "message_start") return this.messageStart(record)
    if (type === "content_block_start") return this.contentBlockStart(record)
    if (type === "content_block_delta") return this.contentBlockDelta(record)
    if (type === "content_block_stop") return this.contentBlockStop(record)
    if (type === "message_delta") return this.messageDelta(record)
    if (type === "message_stop") return this.messageStop()
    return { events: [], terminal: false }
  }

  finish(): ModelStreamEvent[] {
    if (!this.terminal) throw malformed("Anthropic stream ended without message_stop")
    return []
  }

  private messageStart(record: RecordValue): { events: ModelStreamEvent[]; terminal: boolean } {
    const message = asRecord(record.message, "Anthropic message_start message")
    if (message.type !== undefined && message.type !== "message") throw malformed("Anthropic message_start has an invalid message type")
    const usage = message.usage
    if (usage !== undefined) this.readUsage(usage, "Anthropic message_start usage")
    return { events: [], terminal: false }
  }

  private contentBlockStart(record: RecordValue): { events: ModelStreamEvent[]; terminal: boolean } {
    const index = requiredIndex(record.index, "Anthropic content block index")
    if (this.blockKinds.has(index)) throw malformed("Anthropic content block index was reused")
    const block = asRecord(record.content_block, "Anthropic content block")
    const type = stringValue(block.type)
    if (!type) throw malformed("Anthropic content block is missing type")
    if (type === "text") {
      this.blockKinds.set(index, "text")
      return { events: [], terminal: false }
    }
    if (type === "tool_use") {
      const callId = requiredString(block.id, "Anthropic tool_use id")
      const providerName = requiredString(block.name, "Anthropic tool_use name")
      const name = this.toolNameMap.get(providerName) ?? providerName
      const events = this.tools.accept(index, { callId, name })
      if (block.input !== undefined && !isRecord(block.input)) throw malformed("Anthropic tool_use input must be an object")
      if (block.input !== undefined && Object.keys(block.input).length > 0) this.tools.setFullArguments(index, JSON.stringify(block.input))
      this.blockKinds.set(index, "tool_use")
      return { events, terminal: false }
    }
    if (type === "thinking" || type === "redacted_thinking") {
      this.blockKinds.set(index, "thinking")
      return { events: [], terminal: false }
    }
    this.blockKinds.set(index, "ignored")
    return { events: [], terminal: false }
  }

  private contentBlockDelta(record: RecordValue): { events: ModelStreamEvent[]; terminal: boolean } {
    const index = requiredIndex(record.index, "Anthropic content block index")
    const kind = this.blockKinds.get(index)
    if (!kind) throw malformed("Anthropic content block delta arrived before content_block_start")
    const delta = asRecord(record.delta, "Anthropic content block delta")
    const type = stringValue(delta.type)
    if (!type) throw malformed("Anthropic content block delta is missing type")
    if (type === "text_delta") {
      if (kind !== "text") throw malformed("Anthropic text delta targeted a non-text block")
      const text = requiredString(delta.text, "Anthropic text delta")
      return { events: [{ type: "text_delta", text }], terminal: false }
    }
    if (type === "input_json_delta") {
      if (kind !== "tool_use") throw malformed("Anthropic input JSON delta targeted a non-tool block")
      const partialJson = requiredString(delta.partial_json, "Anthropic input JSON delta")
      return { events: this.tools.accept(index, {}, partialJson), terminal: false }
    }
    if (type === "thinking_delta" || type === "signature_delta") {
      if (kind !== "thinking") throw malformed("Anthropic reasoning delta targeted a non-thinking block")
      requiredString(delta.thinking ?? delta.signature, "Anthropic reasoning delta")
      return { events: [], terminal: false }
    }
    if (type === "citations_delta") return { events: [], terminal: false }
    throw malformed(`Anthropic content block delta type is not supported: ${type}`)
  }

  private contentBlockStop(record: RecordValue): { events: ModelStreamEvent[]; terminal: boolean } {
    const index = requiredIndex(record.index, "Anthropic content block index")
    if (!this.blockKinds.has(index)) throw malformed("Anthropic content block stop arrived before content_block_start")
    return { events: [], terminal: false }
  }

  private messageDelta(record: RecordValue): { events: ModelStreamEvent[]; terminal: boolean } {
    const delta = asRecord(record.delta, "Anthropic message_delta delta")
    if (delta.stop_reason !== null && delta.stop_reason !== undefined) this.finishReason = finishReason(delta.stop_reason)
    if (record.usage !== undefined) this.readUsage(record.usage, "Anthropic message_delta usage")
    return { events: [], terminal: false }
  }

  private messageStop(): { events: ModelStreamEvent[]; terminal: boolean } {
    if (!this.finishReason) throw malformed("Anthropic message_stop arrived without stop_reason")
    const events: ModelStreamEvent[] = []
    if (!this.usageEmitted && this.inputTokens !== undefined && this.outputTokens !== undefined) {
      this.usageEmitted = true
      events.push({ type: "usage", inputTokens: this.inputTokens, outputTokens: this.outputTokens })
    }
    events.push(...this.tools.complete(this.finishReason))
    this.terminal = true
    return { events, terminal: true }
  }

  private readUsage(value: unknown, label: string): void {
    const usage = asRecord(value, label)
    if (usage.input_tokens !== undefined) this.inputTokens = requiredToken(usage.input_tokens, `${label} input_tokens`)
    if (usage.output_tokens !== undefined) this.outputTokens = requiredToken(usage.output_tokens, `${label} output_tokens`)
  }
}

function finishReason(value: unknown): ModelFinishReason {
  if (value === "end_turn" || value === "stop_sequence" || value === "pause_turn") return "stop"
  if (value === "tool_use") return "tool_calls"
  if (value === "max_tokens") return "length"
  if (value === "refusal") return "content_filter"
  throw malformed("Anthropic returned an unknown stop reason")
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw malformed(`${label} is not an object`)
  return value
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value)
  if (!result?.trim()) throw malformed(`${label} is missing or empty`)
  return result
}

function requiredIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw malformed(`${label} is invalid`)
  return value as number
}

function requiredToken(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw malformed(`${label} is invalid`)
  return value as number
}

function malformed(message: string): AgentModelError {
  return new AgentModelError({ code: "malformed_response", message, recoverable: true })
}

function providerError(message: string): AgentModelError {
  return new AgentModelError({ code: "provider_error", message, retryable: true, recoverable: true })
}
