import { JobsSearchInputSchema } from "./discovery-tool-types"

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
  | "schemaVersion"
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

const SNAPSHOT_SCHEMA_VERSION = "agent-harness.v2.scheduled-automation-snapshot.v1"
const SNAPSHOT_KEYS = new Set([
  "schemaVersion", "targetRoles", "targetLocations", "minScore", "dailyCap", "requireApproval", "autoApply",
])

type SearchTargetField = "targetRoles" | "targetLocations"
type SearchTargetBounds = { minItems: number; maxItems: number; minLength: number; maxLength: number }

function schemaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeSchemaBound(value: unknown, fallback?: number): number | null {
  if (value === undefined && fallback !== undefined) return fallback
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readSearchTargetBounds(field: SearchTargetField): SearchTargetBounds {
  const property = schemaRecord(schemaRecord(JobsSearchInputSchema.properties)?.[field])
  const items = schemaRecord(property?.items)
  const minItems = safeSchemaBound(property?.minItems, 0)
  const maxItems = safeSchemaBound(property?.maxItems)
  const minLength = safeSchemaBound(items?.minLength, 0)
  const maxLength = safeSchemaBound(items?.maxLength)
  if (property?.type !== "array" || items?.type !== "string" || minItems === null || maxItems === null ||
      minLength === null || maxLength === null || minItems > maxItems || minLength > maxLength) {
    throw new TypeError("Invalid JobsSearchInputSchema bounds for " + field + ".")
  }
  return { minItems, maxItems, minLength, maxLength }
}

const SEARCH_TARGET_BOUNDS: Record<SearchTargetField, SearchTargetBounds> = {
  targetRoles: readSearchTargetBounds("targetRoles"),
  targetLocations: readSearchTargetBounds("targetLocations"),
}

function parseSearchTargetList(value: unknown, field: SearchTargetField, normalizeBeforeValidation: boolean): string[] {
  const bounds = SEARCH_TARGET_BOUNDS[field]
  if (!Array.isArray(value)) {
    throw new ScheduledAutomationSnapshotValidationError(field, "an array of strings")
  }
  if (value.length < bounds.minItems || value.length > bounds.maxItems) {
    throw new ScheduledAutomationSnapshotValidationError(
      field,
      "an array with " + bounds.minItems + " through " + bounds.maxItems + " entries",
    )
  }

  const copy: string[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    if (typeof entry !== "string") {
      throw new ScheduledAutomationSnapshotValidationError(field, "an array of strings")
    }
    const validatedEntry = normalizeBeforeValidation ? entry.trim() : entry
    if (!validatedEntry.trim() || validatedEntry.length < bounds.minLength) {
      throw new ScheduledAutomationSnapshotValidationError(field, "an array of non-empty strings")
    }
    if (validatedEntry.length > bounds.maxLength) {
      throw new ScheduledAutomationSnapshotValidationError(
        field,
        "an array of non-empty strings up to " + bounds.maxLength + " characters",
      )
    }
    copy.push(entry.trim())
  }
  return copy
}

export function isValidDiscoverySearchTargetList(value: unknown, field: SearchTargetField): value is string[] {
  try {
    parseSearchTargetList(value, field, false)
    return true
  } catch {
    return false
  }
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

function snapshotFromFields(fields: Record<string, unknown>, normalizeBeforeValidation: boolean): ScheduledAutomationSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    targetRoles: parseSearchTargetList(fields.targetRoles, "targetRoles", normalizeBeforeValidation),
    targetLocations: parseSearchTargetList(fields.targetLocations, "targetLocations", normalizeBeforeValidation),
    minScore: readBoundedInteger(fields.minScore, "minScore", 0, 100),
    dailyCap: readBoundedInteger(fields.dailyCap, "dailyCap", 1, 50),
    requireApproval: readBoolean(fields.requireApproval, "requireApproval"),
    autoApply: readBoolean(fields.autoApply, "autoApply"),
  }
}

export function parseScheduledAutomationSnapshot(value: unknown): ScheduledAutomationSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduledAutomationSnapshotValidationError("input", "a complete snapshot object")
  }

  const fields = value as Record<string, unknown>
  if (Object.keys(fields).length !== SNAPSHOT_KEYS.size || Object.keys(fields).some(key => !SNAPSHOT_KEYS.has(key))) {
    throw new ScheduledAutomationSnapshotValidationError("input", "the complete snapshot envelope")
  }
  if (fields.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new ScheduledAutomationSnapshotValidationError("schemaVersion", SNAPSHOT_SCHEMA_VERSION)
  }
  return snapshotFromFields(fields, false)
}

export function buildScheduledAutomationSnapshot(
  input: ScheduledAutomationSnapshotInput,
): ScheduledAutomationSnapshot {
  const value: unknown = input
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduledAutomationSnapshotValidationError("input", "an object")
  }

  const fields = value as Record<string, unknown>
  return snapshotFromFields(fields, true)
}
