import { Buffer } from "node:buffer"
import { AgentModelError, type HarnessModelRequest, type ModelCapabilityProfile } from "@jobcopilot/agent-model"

export const MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION = 1 as const
export const MODEL_REQUEST_ADMISSION_METHOD = "serialized_utf8_bytes_div3_ceil_plus_framing" as const

export type ModelRequestAdmissionUnknownReason =
  | "context_window_unknown"
  | "output_reserve_unknown"
  | "continuation_state_unmeasurable"
  | "non_text_content"
  | "unserializable_request"
  | "estimate_overflow"

export type ModelRequestAdmissionEstimate =
  | {
      status: "known"
      estimateVersion: typeof MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION
      method: typeof MODEL_REQUEST_ADMISSION_METHOD
      estimatedInputTokens: number
      outputReserveTokens: number
      contextWindowTokens: number
      withinWindow: boolean
    }
  | {
      status: "unknown"
      estimateVersion: typeof MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION
      method: typeof MODEL_REQUEST_ADMISSION_METHOD
      reason: ModelRequestAdmissionUnknownReason
    }

export type ContextEstimateExceededErrorOptions = {
  provider: string
  model: string
  guaranteedNoProviderAttempt: boolean
}

/** Local route rejection. The caller must state whether any route was already invoked. */
export class ContextEstimateExceededError extends AgentModelError {
  readonly guaranteedNoProviderAttempt: boolean

  constructor(options: ContextEstimateExceededErrorOptions) {
    super({
      code: "context_estimate_exceeded",
      message: "Approximate request context exceeds this model route's window. Choose a larger-context route or reduce retained prompt/tool context; required content was not removed.",
      provider: options.provider,
      model: options.model,
      retryable: false,
      recoverable: false,
    })
    this.name = "ContextEstimateExceededError"
    this.guaranteedNoProviderAttempt = options.guaranteedNoProviderAttempt
  }
}

const BASE_REQUEST_FRAMING_TOKENS = 12
const MESSAGE_FRAMING_TOKENS = 4
const CONTENT_PART_FRAMING_TOKENS = 2
const TOOL_FRAMING_TOKENS = 8
const OUTPUT_SCHEMA_FRAMING_TOKENS = 8
const TOOL_CHOICE_FRAMING_TOKENS = 2

/**
 * Estimates a full route-adapted request; this is admission guidance, never provider usage.
 * The versioned heuristic uses ceil(UTF-8 bytes / 3) plus fixed framing allowances.
 */
export function estimateModelRequestAdmission(
  request: HarnessModelRequest,
  profile: ModelCapabilityProfile,
): ModelRequestAdmissionEstimate {
  const contextWindowTokens = positiveProfileLimit(profile.maxContextTokens, "context window", profile)
  const outputCapability = positiveProfileLimit(profile.maxOutputTokens, "output capability maximum", profile)
  const defaultOutput = optionalProfileLimit(profile.defaultMaxOutputTokens, "default output cap", profile)
  if (defaultOutput !== null && outputCapability !== null && defaultOutput > outputCapability) {
    throw profileError(profile, "Default output cap exceeds the declared output capability maximum")
  }
  if (defaultOutput !== null && contextWindowTokens !== null && defaultOutput > contextWindowTokens) {
    throw profileError(profile, "Default output cap exceeds the declared context window")
  }

  const explicitOutput = request.maxOutputTokens as unknown
  let outputReserveTokens: number | null
  if (explicitOutput === undefined || explicitOutput === null) {
    outputReserveTokens = defaultOutput
  } else {
    if (!isPositiveSafeInteger(explicitOutput)) throw requestError(request, "Explicit output cap must be a positive safe integer")
    if (outputCapability !== null && explicitOutput > outputCapability) {
      throw requestError(request, "Explicit output cap exceeds the model's declared capability maximum")
    }
    outputReserveTokens = explicitOutput
  }

  if (contextWindowTokens === null) return unknown("context_window_unknown")
  if (outputReserveTokens === null) return unknown("output_reserve_unknown")
  try {
    if (hasUnmeasurableContinuation(request.continuation)) return unknown("continuation_state_unmeasurable")
    if (hasNonTextContent(request.messages)) return unknown("non_text_content")

    const requestPayload = {
      messages: request.messages,
      tools: request.tools,
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    }
    const serialized = safeDeterministicJson(requestPayload)
    if (serialized === null) return unknown("unserializable_request")

    const messageCount = request.messages.length
    const contentPartCount = request.messages.reduce((total, message) => total + message.content.length, 0)
    const framingTokens = BASE_REQUEST_FRAMING_TOKENS
      + messageCount * MESSAGE_FRAMING_TOKENS
      + contentPartCount * CONTENT_PART_FRAMING_TOKENS
      + request.tools.length * TOOL_FRAMING_TOKENS
      + (request.outputSchema === undefined ? 0 : OUTPUT_SCHEMA_FRAMING_TOKENS)
      + (request.toolChoice === undefined ? 0 : TOOL_CHOICE_FRAMING_TOKENS)

    const estimatedInputTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 3) + framingTokens
    const totalEstimatedTokens = estimatedInputTokens + outputReserveTokens
    if (!Number.isSafeInteger(estimatedInputTokens) || !Number.isSafeInteger(totalEstimatedTokens)) return unknown("estimate_overflow")
    return {
      status: "known",
      estimateVersion: MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION,
      method: MODEL_REQUEST_ADMISSION_METHOD,
      estimatedInputTokens,
      outputReserveTokens,
      contextWindowTokens,
      withinWindow: totalEstimatedTokens <= contextWindowTokens,
    }
  } catch {
    return unknown("unserializable_request")
  }
}

function positiveProfileLimit(value: unknown, label: string, profile: ModelCapabilityProfile): number | null {
  if (value === null || value === undefined) return null
  if (!isPositiveSafeInteger(value)) throw profileError(profile, `Declared ${label} must be a positive safe integer or null`)
  return value
}

function optionalProfileLimit(value: unknown, label: string, profile: ModelCapabilityProfile): number | null {
  return positiveProfileLimit(value, label, profile)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function profileError(profile: ModelCapabilityProfile, message: string): AgentModelError {
  return new AgentModelError({ code: "configuration_error", message, provider: profile.provider, model: profile.model })
}

function requestError(request: HarnessModelRequest, message: string): AgentModelError {
  return new AgentModelError({ code: "invalid_request", message, provider: request.provider, model: request.model })
}

function unknown(reason: ModelRequestAdmissionUnknownReason): ModelRequestAdmissionEstimate {
  return { status: "unknown", estimateVersion: MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION, method: MODEL_REQUEST_ADMISSION_METHOD, reason }
}

function hasUnmeasurableContinuation(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== "object" || Array.isArray(value)) return true
  const continuation = value as Record<string, unknown>
  const allowedKeys = new Set(["cursor", "providerResponseId", "providerConversationId"])
  for (const key of Reflect.ownKeys(continuation)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) return true
    const descriptor = Object.getOwnPropertyDescriptor(continuation, key)
    if (!descriptor || !("value" in descriptor)) return true
    const part = descriptor.value
    if (part === undefined || part === null || part === "") continue
    if (typeof part !== "string") return true
    return true
  }
  return false
}

function hasNonTextContent(messages: HarnessModelRequest["messages"]): boolean {
  if (!Array.isArray(messages)) return true
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) return true
    for (const part of message.content) {
      if (!part || typeof part !== "object") return true
      const type = (part as { type?: unknown }).type
      if (type === "attachment_ref") return true
      if (type === "text" && typeof (part as { text?: unknown }).text === "string") continue
      if (type === "tool_use" && typeof (part as { name?: unknown }).name === "string") continue
      if (type === "tool_result" && typeof (part as { content?: unknown }).content === "string") continue
      return true
    }
  }
  return false
}

function safeDeterministicJson(value: unknown): string | null {
  try {
    return deterministicJson(value, new Set())
  } catch {
    return null
  }
}

function deterministicJson(value: unknown, ancestors: Set<object>): string | null {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null
  if (typeof value !== "object") return null
  if (ancestors.has(value)) return null
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return null
      const values: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
        const serialized = deterministicJson(descriptor.value, ancestors)
        if (serialized === null) return null
        values.push(serialized)
      }
      return `[${values.join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const stringKeys = Object.keys(value).sort()
    const entries: string[] = []
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      if (descriptor.value === undefined) continue
      const serialized = deterministicJson(descriptor.value, ancestors)
      if (serialized === null) return null
      entries.push(`${JSON.stringify(key)}:${serialized}`)
    }
    return `{${entries.join(",")}}`
  } finally {
    ancestors.delete(value)
  }
}
