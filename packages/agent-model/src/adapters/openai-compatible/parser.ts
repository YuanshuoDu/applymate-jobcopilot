import { AgentModelError } from "../../errors.js"
import type { ModelFinishReason, ModelStreamEvent } from "../../contracts.js"
import { ToolCallAccumulator } from "./tool-aggregation.js"
import type { OpenAiEventParser, OpenAiParserResult } from "./types.js"

type RecordValue = Record<string, unknown>

export class ChatCompletionsParser implements OpenAiEventParser {
  private readonly tools = new ToolCallAccumulator()
  private finishReason: ModelFinishReason | undefined
  private usageEmitted = false

  consume(_eventName: string | undefined, data: unknown): OpenAiParserResult {
    const record = asRecord(data, "Chat Completions event")
    if (record.error) throw providerError("Chat Completions provider returned an error")
    const events: ModelStreamEvent[] = []
    const choices = record.choices
    if (Array.isArray(choices)) {
      const choice = choices[0]
      if (choice !== undefined) {
        const choiceRecord = asRecord(choice, "Chat Completions choice")
        const delta = choiceRecord.delta
        if (delta !== undefined) events.push(...this.parseDelta(asRecord(delta, "Chat Completions delta")))
        if (choiceRecord.finish_reason !== null && choiceRecord.finish_reason !== undefined) {
          this.finishReason = finishReason(choiceRecord.finish_reason)
        }
      }
    }
    const usage = usageEvent(record.usage)
    if (usage && !this.usageEmitted) {
      this.usageEmitted = true
      events.push(usage)
    }
    return { events, terminal: false }
  }

  finish(): ModelStreamEvent[] {
    if (!this.finishReason) throw malformed("Chat Completions stream ended without finish_reason")
    return this.tools.complete(this.finishReason)
  }

  private parseDelta(delta: RecordValue): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = []
    const text = stringValue(delta.content)
    if (text) events.push({ type: "text_delta", text })
    const reasoning = stringValue(delta.reasoning_content) ?? stringValue(delta.reasoning)
    if (reasoning) events.push({ type: "reasoning_summary_delta", text: reasoning })
    if (Array.isArray(delta.tool_calls)) {
      for (const value of delta.tool_calls) {
        const toolCall = asRecord(value, "Chat Completions tool call")
        const index = numberValue(toolCall.index)
        if (index === undefined) throw malformed("Chat Completions tool call is missing index")
        const functionValue = toolCall.function
        const functionRecord = functionValue === undefined ? {} : asRecord(functionValue, "Chat Completions function call")
        events.push(...this.tools.accept(index, {
          callId: stringValue(toolCall.id),
          name: stringValue(functionRecord.name),
        }, argumentString(functionRecord.arguments)))
      }
    }
    return events
  }
}

export class ResponsesParser implements OpenAiEventParser {
  private readonly tools = new ToolCallAccumulator()
  private readonly itemIndexes = new Map<string, number>()
  private nextIndex = 0
  private usageEmitted = false
  private terminal = false

  consume(eventName: string | undefined, data: unknown): OpenAiParserResult {
    if (this.terminal) return { events: [], terminal: true }
    const record = asRecord(data, "Responses event")
    const type = eventName ?? stringValue(record.type)
    if (type === "error" || record.error) throw providerError("Responses provider returned an error")
    if (type === "response.output_text.delta") return this.textDelta(record)
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary.delta") {
      const text = stringValue(record.delta)
      return { events: text ? [{ type: "reasoning_summary_delta", text }] : [], terminal: false }
    }
    if (type === "response.output_item.added") return this.outputItemAdded(record)
    if (type === "response.function_call_arguments.delta") return this.functionArgumentsDelta(record)
    if (type === "response.function_call_arguments.done") return this.functionArgumentsDone(record)
    if (type === "response.output_item.done") return this.outputItemDone(record)
    if (type === "response.completed") return this.responseCompleted(record)
    if (type === "response.incomplete") return this.responseIncomplete(record)
    if (type === "response.failed") throw providerError("Responses provider reported a failed response")
    return { events: [], terminal: false }
  }

  finish(): ModelStreamEvent[] {
    if (!this.terminal) throw malformed("Responses stream ended without a terminal response event")
    return []
  }

  private textDelta(record: RecordValue): OpenAiParserResult {
    const text = stringValue(record.delta)
    return { events: text ? [{ type: "text_delta", text }] : [], terminal: false }
  }

  private outputItemAdded(record: RecordValue): OpenAiParserResult {
    const item = asRecord(record.item, "Responses output item")
    if (stringValue(item.type) !== "function_call") return { events: [], terminal: false }
    const index = this.indexFor(record.output_index, stringValue(item.id))
    const args = argumentString(item.arguments)
    const events = this.tools.accept(index, {
      callId: stringValue(item.call_id),
      name: stringValue(item.name),
    }, args)
    return { events, terminal: false }
  }

  private functionArgumentsDelta(record: RecordValue): OpenAiParserResult {
    const index = this.indexFor(record.output_index, stringValue(record.item_id))
    const events = this.tools.accept(index, {
      callId: stringValue(record.call_id),
      name: stringValue(record.name),
    }, argumentString(record.delta))
    return { events, terminal: false }
  }

  private functionArgumentsDone(record: RecordValue): OpenAiParserResult {
    const index = this.indexFor(record.output_index, stringValue(record.item_id))
    this.tools.setFullArguments(index, argumentString(record.arguments) ?? "", {
      callId: stringValue(record.call_id), name: stringValue(record.name),
    })
    return { events: [], terminal: false }
  }

  private outputItemDone(record: RecordValue): OpenAiParserResult {
    const item = asRecord(record.item, "Responses output item")
    if (stringValue(item.type) !== "function_call") return { events: [], terminal: false }
    const index = this.indexFor(record.output_index, stringValue(item.id))
    this.tools.setFullArguments(index, argumentString(item.arguments) ?? "", {
      callId: stringValue(item.call_id), name: stringValue(item.name),
    })
    return { events: [], terminal: false }
  }

  private responseCompleted(record: RecordValue): OpenAiParserResult {
    const response = asRecord(record.response, "Responses completed response")
    const id = stringValue(response.id)
    if (!id) throw malformed("Responses completed without a response id")
    const usage = usageEvent(response.usage)
    const events: ModelStreamEvent[] = usage && !this.usageEmitted ? [usage] : []
    this.usageEmitted = this.usageEmitted || events.length > 0
    const conversationId = stringValue(response.conversation_id)
    events.push({ type: "continuation", continuation: {
      cursor: id, providerResponseId: id, ...(conversationId ? { providerConversationId: conversationId } : {}),
    } })
    events.push(...this.tools.complete(this.tools.hasCalls() ? "tool_calls" : "stop"))
    this.terminal = true
    return { events, terminal: true }
  }

  private responseIncomplete(record: RecordValue): OpenAiParserResult {
    const response = record.response === undefined ? record : asRecord(record.response, "Responses incomplete response")
    const usage = usageEvent(response.usage)
    const events: ModelStreamEvent[] = usage && !this.usageEmitted ? [usage] : []
    this.usageEmitted = this.usageEmitted || events.length > 0
    if (this.tools.hasCalls()) throw malformed("Responses stream ended with incomplete tool arguments")
    events.push({ type: "completed", finishReason: "length" })
    this.terminal = true
    return { events, terminal: true }
  }

  private indexFor(outputIndex: unknown, itemId: string | undefined): number {
    if (typeof outputIndex === "number" && Number.isSafeInteger(outputIndex) && outputIndex >= 0) {
      if (itemId) this.itemIndexes.set(itemId, outputIndex)
      this.nextIndex = Math.max(this.nextIndex, outputIndex + 1)
      return outputIndex
    }
    if (itemId) {
      const existing = this.itemIndexes.get(itemId)
      if (existing !== undefined) return existing
      const index = this.nextIndex++
      this.itemIndexes.set(itemId, index)
      return index
    }
    return this.nextIndex++
  }
}

function usageEvent(value: unknown): Extract<ModelStreamEvent, { type: "usage" }> | undefined {
  if (!value) return undefined
  const record = asRecord(value, "usage")
  const inputTokens = numberValue(record.prompt_tokens) ?? numberValue(record.input_tokens)
  const outputTokens = numberValue(record.completion_tokens) ?? numberValue(record.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { type: "usage", inputTokens, outputTokens }
}

function finishReason(value: unknown): ModelFinishReason {
  if (value === "stop") return "stop"
  if (value === "tool_calls" || value === "function_call") return "tool_calls"
  if (value === "length") return "length"
  if (value === "content_filter") return "content_filter"
  throw malformed("Provider returned an unknown finish reason")
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed(`${label} is not an object`)
  return value as RecordValue
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function argumentString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  throw malformed("Provider returned a non-string tool argument fragment")
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function malformed(message: string): AgentModelError {
  return new AgentModelError({ code: "malformed_response", message, recoverable: true })
}

function providerError(message: string): AgentModelError {
  return new AgentModelError({ code: "provider_error", message, retryable: true, recoverable: true })
}
