import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export type InterruptOperationKind = "model" | "tool" | "task" | "browser" | "wait" | "step"

export type InterruptTarget = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
}

export type InterruptRequestInput = InterruptTarget & {
  readonly requestId: string
  readonly reason?: string
  readonly requestedAt?: Date
}

export type PersistedInterruptRequest = InterruptRequestInput & {
  readonly disposition: "accepted" | "duplicate"
  readonly persistedAt: Date
}

export interface InterruptPersistencePort {
  persist(input: InterruptRequestInput): Promise<PersistedInterruptRequest>
  isRequested(target: InterruptTarget): Promise<boolean>
}

export type TerminalEventInput = InterruptTarget & {
  readonly requestId: string
  readonly reason: string
  readonly payload?: RepositoryJsonValue
}

export type TerminalEventResult = "appended" | "duplicate"

export interface TerminalEventPort {
  append(input: TerminalEventInput): Promise<TerminalEventResult>
}

export type ExternalActionResolution = "completed" | "uncertain"

export type ExternalActionEvidence = InterruptTarget & {
  readonly actionId: string
  readonly operation: string
  readonly startedAt: Date
}

export interface ExternalActionEvidenceResolver {
  reconcile(action: ExternalActionEvidence): Promise<ExternalActionResolution>
}

export type ExternalActionRecord = ExternalActionEvidence & {
  readonly resolution: ExternalActionResolution
  readonly resolvedAt: Date
}

export type InterruptStopResult = InterruptTarget & {
  readonly disposition: "interrupted" | "duplicate"
  readonly terminalEvent: TerminalEventResult
  readonly externalActions: readonly ExternalActionRecord[]
}

export function interruptTargetKey(target: InterruptTarget): string {
  return `${target.userId}:${target.sessionId}:${target.turnId}`
}

export function assertInterruptTarget(target: InterruptTarget): void {
  if (!target || typeof target !== "object") {
    throw new TypeError("Interrupt target must be an object")
  }
  const requiredFields = ["userId", "sessionId", "turnId"] as const
  for (const name of requiredFields) {
    const value = target[name]
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`Interrupt ${name} must be a non-empty string`)
    }
  }
}

export function interruptReason(reason: string | undefined): string {
  const value = reason?.trim() || "user_stop"
  return value.slice(0, 200)
}
