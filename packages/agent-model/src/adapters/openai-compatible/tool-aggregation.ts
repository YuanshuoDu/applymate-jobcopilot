import { AgentModelError } from "../../errors.js"
import type { ModelFinishReason, ModelStreamEvent } from "../../contracts.js"

interface ToolState {
  index: number
  callId?: string
  name?: string
  argumentsText: string
  started: boolean
}

export class ToolCallAccumulator {
  private readonly calls = new Map<number, ToolState>()
  private readonly indexesByCallId = new Map<string, number>()

  hasCalls(): boolean {
    return this.calls.size > 0
  }

  accept(
    index: number,
    identity: { callId?: string; name?: string },
    argumentDelta?: string,
  ): ModelStreamEvent[] {
    const state = this.state(index, identity.callId)
    this.setIdentity(state, identity)
    if (argumentDelta) state.argumentsText += argumentDelta
    const events: ModelStreamEvent[] = []
    if (!state.started && state.callId && state.name) {
      state.started = true
      events.push({ type: "tool_call_started", callId: state.callId, name: state.name })
      if (state.argumentsText) events.push({ type: "tool_arguments_delta", callId: state.callId, delta: state.argumentsText })
    } else if (state.started && argumentDelta) {
      events.push({ type: "tool_arguments_delta", callId: state.callId!, delta: argumentDelta })
    }
    return events
  }

  setFullArguments(index: number, argumentsText: string, identity: { callId?: string; name?: string } = {}): void {
    const state = this.state(index, identity.callId)
    this.setIdentity(state, identity)
    if (argumentsText) state.argumentsText = argumentsText
  }

  complete(finishReason: ModelFinishReason): ModelStreamEvent[] {
    if (this.calls.size === 0) {
      if (finishReason === "tool_calls") throw malformed("Tool call finish had no tool calls")
      return [{ type: "completed", finishReason }]
    }
    if (finishReason !== "tool_calls") throw malformed("Tool call stream ended before tool calls completed")
    const events: ModelStreamEvent[] = []
    for (const state of [...this.calls.values()].sort((left, right) => left.index - right.index)) {
      if (!state.callId || !state.name) throw malformed("Tool call is missing callId or name")
      let argumentsValue: unknown = {}
      if (state.argumentsText.trim()) {
        try {
          argumentsValue = JSON.parse(state.argumentsText) as unknown
        } catch {
          throw malformed("Tool call arguments are truncated or invalid JSON")
        }
      }
      events.push({ type: "tool_call_completed", callId: state.callId, name: state.name, arguments: argumentsValue })
    }
    events.push({ type: "completed", finishReason: "tool_calls" })
    return events
  }

  private state(index: number, callId?: string): ToolState {
    if (!Number.isInteger(index) || index < 0) throw malformed("Tool call index is invalid")
    const existingIndex = callId ? this.indexesByCallId.get(callId) : undefined
    if (existingIndex !== undefined && existingIndex !== index) {
      if (this.calls.has(index)) throw malformed("Tool call id was reused at a different index")
      index = existingIndex
    }
    const existing = this.calls.get(index)
    if (existing) return existing
    const state: ToolState = { index, argumentsText: "", started: false }
    this.calls.set(index, state)
    if (callId) this.indexesByCallId.set(callId, index)
    return state
  }

  private setIdentity(state: ToolState, identity: { callId?: string; name?: string }): void {
    if (identity.callId && state.callId && identity.callId !== state.callId) throw malformed("Tool call id changed mid-stream")
    if (identity.name && state.name && identity.name !== state.name) throw malformed("Tool name changed mid-stream")
    if (identity.callId) state.callId = identity.callId
    if (state.callId) this.indexesByCallId.set(state.callId, state.index)
    if (identity.name) state.name = identity.name
  }
}

function malformed(message: string): AgentModelError {
  return new AgentModelError({ code: "malformed_response", message, recoverable: true })
}
