export interface ScheduledAutomationSnapshotInput {
  readonly targetRoles?: unknown
  readonly targetLocations?: unknown
  readonly minScore?: unknown
  readonly dailyCap?: unknown
  readonly requireApproval?: unknown
  readonly autoApply?: unknown
}

export interface ScheduledAutomationSnapshot {
  schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1"
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

export type ScheduledAutomationSnapshotField =
  | "input"
  | "targetRoles"
  | "targetLocations"
  | "minScore"
  | "dailyCap"
  | "requireApproval"
  | "autoApply"

export class ScheduledAutomationSnapshotValidationError extends TypeError {
  readonly field: ScheduledAutomationSnapshotField
  readonly code = "INVALID_SCHEDULED_AUTOMATION_SNAPSHOT"

  constructor(field: ScheduledAutomationSnapshotField, expected: string) {
    super('Invalid scheduled automation snapshot field "' + field + '": expected ' + expected + '.')
    this.name = "ScheduledAutomationSnapshotValidationError"
    this.field = field
  }
}

function readStringArray(value: unknown, field: "targetRoles" | "targetLocations"): string[] {
  if (!Array.isArray(value)) {
    throw new ScheduledAutomationSnapshotValidationError(field, "an array of strings")
  }

  const copy: string[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    if (typeof entry !== "string") {
      throw new ScheduledAutomationSnapshotValidationError(field, "an array of strings")
    }
    copy.push(entry)
  }
  return copy
}

function readBoundedInteger(value: unknown, field: "minScore" | "dailyCap", min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ScheduledAutomationSnapshotValidationError(field, "an integer from " + min + " through " + max)
  }
  return value
}

function readBoolean(value: unknown, field: "requireApproval" | "autoApply"): boolean {
  if (typeof value !== "boolean") {
    throw new ScheduledAutomationSnapshotValidationError(field, "a boolean")
  }
  return value
}

export function buildScheduledAutomationSnapshot(
  input: ScheduledAutomationSnapshotInput,
): ScheduledAutomationSnapshot {
  const value: unknown = input
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduledAutomationSnapshotValidationError("input", "an object")
  }

  const fields = value as Record<string, unknown>
  return {
    schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
    targetRoles: readStringArray(fields.targetRoles, "targetRoles"),
    targetLocations: readStringArray(fields.targetLocations, "targetLocations"),
    minScore: readBoundedInteger(fields.minScore, "minScore", 0, 100),
    dailyCap: readBoundedInteger(fields.dailyCap, "dailyCap", 1, 50),
    requireApproval: readBoolean(fields.requireApproval, "requireApproval"),
    autoApply: readBoolean(fields.autoApply, "autoApply"),
  }
}
