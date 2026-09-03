import {
  rebuildAfterCursorLoss,
  type CursorRecoveryResult,
} from "@jobcopilot/agent-model"
import type { HarnessModelRequest, ModelMessage } from "@jobcopilot/agent-model"

export type CursorRerouteInput<T> = {
  readonly request: HarnessModelRequest
  readonly failure: unknown
  readonly loadCanonicalMessages: () => Promise<readonly ModelMessage[]>
  readonly selectProvider?: (request: HarnessModelRequest) => HarnessModelRequest
  readonly invoke: (request: HarnessModelRequest) => Promise<T>
}

export type CursorRerouteResult<T> = {
  readonly recovery: CursorRecoveryResult
  readonly value: T
}

/** Rebuilds from the durable provider-neutral context before trying another route. */
export async function rerouteAfterCursorLoss<T>(input: CursorRerouteInput<T>): Promise<CursorRerouteResult<T>> {
  const canonicalMessages = await input.loadCanonicalMessages()
  const recovery = rebuildAfterCursorLoss(input.request, canonicalMessages, input.failure)
  const reroutedRequest = input.selectProvider?.(recovery.request) ?? recovery.request
  return { recovery, value: await input.invoke(reroutedRequest) }
}
