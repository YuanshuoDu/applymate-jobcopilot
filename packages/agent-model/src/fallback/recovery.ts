import {
  AgentModelError,
  isAgentModelError,
  type ModelErrorDescriptor,
} from "../errors.js"
import type {
  HarnessModelRequest,
  ModelContinuation,
} from "../contracts.js"
import type { ModelMessage } from "@jobcopilot/agent-protocol"

export interface CursorRecoveryResult {
  request: HarnessModelRequest
  reason: "cursor_lost"
  failure: ModelErrorDescriptor
  previousContinuation: ModelContinuation
}

export function isCursorLoss(error: unknown): error is AgentModelError {
  return isAgentModelError(error) && error.code === "cursor_lost"
}

export function rebuildAfterCursorLoss(
  request: HarnessModelRequest,
  canonicalMessages: readonly ModelMessage[],
  error: unknown,
): CursorRecoveryResult {
  if (!isCursorLoss(error)) throw invalidRecovery("Only a cursor_lost error can trigger context rebuild")
  if (canonicalMessages.length === 0) throw invalidRecovery("Canonical context must contain at least one message")
  const previousContinuation = request.continuation ?? {}
  return {
    request: withoutProviderContinuation(request, canonicalMessages),
    reason: "cursor_lost",
    failure: error.descriptor(),
    previousContinuation,
  }
}

function withoutProviderContinuation(
  request: HarnessModelRequest,
  canonicalMessages: readonly ModelMessage[],
): HarnessModelRequest {
  const { continuation: _continuation, ...withoutContinuation } = request
  return {
    ...withoutContinuation,
    messages: canonicalMessages.map(cloneMessage),
  }
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    role: message.role,
    content: message.content.map(part => ({ ...part })),
  }
}

function invalidRecovery(message: string): AgentModelError {
  return new AgentModelError({ code: "invalid_request", message, recoverable: false })
}
