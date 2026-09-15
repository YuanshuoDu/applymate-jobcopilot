export type UsageExecutionOwner =
  | { kind: "turn"; leaseOwnerId: string; leaseVersion: number }
  | { kind: "task"; taskId: string; rootTaskId: string; ownerId: string; attemptCount: number }

type LegacyTurnOwner = {
  executionOwner?: never
  leaseOwnerId: string
  leaseVersion: number
}

type EnvelopedOwner = {
  executionOwner: UsageExecutionOwner
  leaseOwnerId?: never
  leaseVersion?: never
}

export type UsageAdmissionOwnerInput = LegacyTurnOwner | EnvelopedOwner

export class UsageOwnerFenceError extends Error {
  constructor(message = "usage_fence_rejected") {
    super(message)
    this.name = "UsageOwnerFenceError"
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new UsageOwnerFenceError()
  return Number(value)
}

function attempt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new UsageOwnerFenceError()
  return Number(value)
}

function validOwner(value: unknown): UsageExecutionOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageOwnerFenceError()
  const row = value as Record<string, unknown>
  const hasTaskFields = ["taskId", "rootTaskId", "ownerId", "attemptCount"].some(key => Object.prototype.hasOwnProperty.call(row, key))
  const hasTurnFields = ["leaseOwnerId", "leaseVersion"].some(key => Object.prototype.hasOwnProperty.call(row, key))
  if (row.kind === "turn" && text(row.leaseOwnerId)) {
    if (hasTaskFields) throw new UsageOwnerFenceError("usage_owner_conflict")
    return { kind: "turn", leaseOwnerId: row.leaseOwnerId, leaseVersion: version(row.leaseVersion) }
  }
  if (row.kind === "task" && text(row.taskId) && text(row.rootTaskId) && text(row.ownerId)) {
    if (hasTurnFields) throw new UsageOwnerFenceError("usage_owner_conflict")
    return { kind: "task", taskId: row.taskId, rootTaskId: row.rootTaskId, ownerId: row.ownerId, attemptCount: attempt(row.attemptCount) }
  }
  throw new UsageOwnerFenceError()
}

/** Normalize the legacy root lease or a discriminated owner envelope. */
export function normalizeUsageOwner(input: UsageAdmissionOwnerInput): UsageExecutionOwner {
  const row = input as Record<string, unknown>
  const hasEnvelope = Object.prototype.hasOwnProperty.call(row, "executionOwner")
  const hasLegacy = Object.prototype.hasOwnProperty.call(row, "leaseOwnerId") || Object.prototype.hasOwnProperty.call(row, "leaseVersion")
  const hasChildFields = ["taskId", "rootTaskId", "ownerId", "attemptCount"].some(key => Object.prototype.hasOwnProperty.call(row, key))
  if (hasEnvelope && (hasLegacy || hasChildFields)) throw new UsageOwnerFenceError("usage_owner_conflict")
  if (hasEnvelope) return validOwner(row.executionOwner)
  if (!hasLegacy || hasChildFields || !text(row.leaseOwnerId)) throw new UsageOwnerFenceError()
  return { kind: "turn", leaseOwnerId: row.leaseOwnerId, leaseVersion: version(row.leaseVersion) }
}
