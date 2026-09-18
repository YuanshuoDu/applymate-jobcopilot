import type { InputContentPart } from "@jobcopilot/agent-protocol"

export type StepCheckpoint = { readonly inputThroughSequence: bigint; readonly consumedInputIds: readonly string[] }
export type TurnExecutionFence = { readonly ownerId: string; readonly leaseVersion: number; readonly now: Date }
export type StoredAgentInput = {
  readonly id: string
  readonly sessionId: string
  readonly targetTurnId: string | null
  readonly userId: string
  readonly clientMessageId: string
  readonly delivery: "steer" | "follow_up"
  readonly status: "accepted" | "queued" | "consumed" | "cancelled" | "rejected"
  readonly content: readonly InputContentPart[]
  readonly acceptedSequence: bigint
  readonly consumedByStepId: string | null
  readonly consumedAt: Date | null
  readonly createdAt: Date
}
export type ClaimInputsRequest = {
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly checkpoint: StepCheckpoint
  readonly mode?: "new" | "retry" | "rebuild"
  readonly rebuild?: boolean
  readonly lease?: TurnExecutionFence
  readonly now: Date
}
export type ClaimedInputs = { readonly inputs: readonly StoredAgentInput[]; readonly newlyClaimedInputIds: readonly string[] }
