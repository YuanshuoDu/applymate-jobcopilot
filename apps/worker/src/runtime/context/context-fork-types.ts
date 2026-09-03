import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { AgentContextSnapshot } from "./context-snapshot-types.js"

export type ForkTurn = { readonly id: string; readonly status: string; readonly createdAt: Date | string | number }
export type ForkItem = {
  readonly id: string; readonly turnId: string; readonly type: string; readonly status: string
  readonly stepId?: string | null; readonly taskId?: string | null; readonly content: unknown
}
export type ForkEvent = {
  readonly id: string; readonly turnId: string; readonly itemId?: string | null; readonly taskId?: string | null
  readonly sequence: bigint | number | string; readonly type: string; readonly actor: string
  readonly correlationId: string; readonly causationId?: string | null; readonly payload: unknown
}
export type ForkSource = {
  readonly sessionId: string; readonly ownerId: string; readonly scope: TenantScope; readonly goal: string
  readonly turns: readonly ForkTurn[]; readonly items: readonly ForkItem[]; readonly events: readonly ForkEvent[]
  readonly snapshot?: AgentContextSnapshot | null
}
export type ForkRequest = { readonly sourceSessionId: string; readonly lastTurnId: string; readonly clientMessageId: string }
export type ForkTurnCopy = ForkTurn & {
  readonly id: string; readonly sourceId: string; readonly leaseOwnerId: null; readonly leaseExpiresAt: null
  readonly leaseStartedAt: null; readonly leaseVersion: 0; readonly revision: 0
}
export type ForkItemCopy = ForkItem & {
  readonly id: string; readonly sourceId: string; readonly turnId: string; readonly stepId: null; readonly taskId: null
}
export type ForkEventCopy = ForkEvent & {
  readonly id: string; readonly sourceId: string; readonly turnId: string; readonly itemId: string | null
  readonly taskId: null; readonly sequence: bigint; readonly idempotencyKey: string
}
export type ForkPlan = {
  readonly targetSessionId: string; readonly sourceSessionId: string; readonly lastTurnId: string; readonly clientMessageId: string; readonly goal: string
  readonly turns: readonly ForkTurnCopy[]; readonly items: readonly ForkItemCopy[]; readonly events: readonly ForkEventCopy[]
  readonly snapshot: AgentContextSnapshot | null; readonly nextEventSequence: bigint
  readonly excluded: { readonly leases: true; readonly receipts: true; readonly pendingInputs: true; readonly approvals: true; readonly reservations: true; readonly outbox: true }
}
export class ContextForkError extends Error {
  constructor(readonly code: "invalid_request" | "owner_mismatch" | "boundary_not_found" | "boundary_active" | "idempotency_conflict", message: string) {
    super(message)
    this.name = "ContextForkError"
  }
}
