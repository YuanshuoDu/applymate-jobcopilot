import { Buffer } from "node:buffer"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"

import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION,
  type TaskGraphObjectiveProgressStatus } from "./task-graph-objective-progress.js"
import type { StepContext } from "./step-context-builder.js"

const MAX_REQUIREMENTS = 8
const MAX_ROW_BYTES = 4 * 1024
const STATUSES = new Set<TaskGraphObjectiveProgressStatus>(["missing", "active", "failed", "unverified", "reported_passed", "unknown"])
const KINDS = new Set(["candidate_count_gte", "finding_count_gte"])

export type ObjectiveProgressRequirement = Readonly<{
  id: string
  kind: "candidate_count_gte" | "finding_count_gte"
  minimum: number
  status: TaskGraphObjectiveProgressStatus
}> | Readonly<{
  id: string
  kind: "candidate_location_in"
  locations: readonly string[]
  status: TaskGraphObjectiveProgressStatus
}>
export type ObjectiveProgressSnapshot = Readonly<{
  schemaVersion: typeof TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION
  advisory: true
  revision: number | null
  requirements: readonly ObjectiveProgressRequirement[]
}>
type ObjectiveProgressDeltaStatus = {
  beforeStatus: TaskGraphObjectiveProgressStatus
  afterStatus: TaskGraphObjectiveProgressStatus
}
export type ObjectiveProgressDeltaRequirement = Readonly<{
  id: string
  kind: "candidate_count_gte" | "finding_count_gte"
  minimum: number
} & ObjectiveProgressDeltaStatus> | Readonly<{
  id: string
  kind: "candidate_location_in"
} & ObjectiveProgressDeltaStatus>
export type ObjectiveProgressDelta = Readonly<{
  schemaVersion: "agent-harness.v2.objective-progress-delta.v1"
  availability: "available" | "unavailable"
  previousPlanRevision: number | null
  currentPlanRevision: number | null
  requirements: readonly ObjectiveProgressDeltaRequirement[]
}>

type Row = Record<string, unknown>
function plain(value: unknown): value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exact(value: Row, keys: readonly string[]): boolean {
  try {
    const ownKeys = Reflect.ownKeys(value)
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key))
      && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  } catch { return false }
}
function field(value: Row, key: string): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { ok: true, value: undefined }
    return descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? { ok: true, value: descriptor.value }
      : { ok: false }
  } catch { return { ok: false } }
}
function denseArray(value: unknown, max: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")
    if (!length || !Object.hasOwn(length, "value") || typeof length.value !== "number"
      || !Number.isSafeInteger(length.value) || length.value > max) return undefined
    const size = length.value
    if (Reflect.ownKeys(value).length !== size + 1) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const rows: unknown[] = []
    for (let index = 0; index < size; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      rows.push(descriptor.value)
    }
    return rows
  } catch { return undefined }
}
function safeRevision(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(value) }
function safeStatus(value: unknown): value is TaskGraphObjectiveProgressStatus {
  return typeof value === "string" && STATUSES.has(value as TaskGraphObjectiveProgressStatus)
}
function canonicalLocations(value: unknown): readonly string[] | undefined {
  const locations = normalizeAgentLocationAllowlist(value), raw = denseArray(value, 8)
  return locations && raw && raw.length === locations.length && raw.every((location, index) => location === locations[index])
    ? locations : undefined
}
function requirement(value: unknown): ObjectiveProgressRequirement | undefined {
  if (!plain(value)) return undefined
  const kind = field(value, "kind")
  if (!kind.ok || typeof kind.value !== "string") return undefined
  if (kind.value === "candidate_location_in") {
    if (!exact(value, ["id", "kind", "locations", "status"])) return undefined
    const id = field(value, "id"), locations = field(value, "locations"), status = field(value, "status")
    if (!id.ok || !locations.ok || !status.ok || !safeId(id.value) || !safeStatus(status.value)) return undefined
    const canonical = canonicalLocations(locations.value)
    return canonical ? { id: id.value, kind: kind.value, locations: canonical, status: status.value } : undefined
  }
  if (!KINDS.has(kind.value) || !exact(value, ["id", "kind", "minimum", "status"])) return undefined
  const id = field(value, "id"), minimum = field(value, "minimum"), status = field(value, "status")
  if (!id.ok || !minimum.ok || !status.ok || !safeId(id.value)
    || typeof minimum.value !== "number" || !Number.isSafeInteger(minimum.value) || minimum.value < 1 || minimum.value > 50
    || !safeStatus(status.value)) return undefined
  return { id: id.value, kind: kind.value as "candidate_count_gte" | "finding_count_gte",
    minimum: minimum.value, status: status.value }
}

/** Copies only the existing bounded projection from one exact current-context observation. */
export function parseObjectiveProgressSnapshot(value: unknown): ObjectiveProgressSnapshot | null {
  if (!plain(value) || !exact(value, ["schemaVersion", "advisory", "revision", "requirements"])) return null
  const schemaVersion = field(value, "schemaVersion"), advisory = field(value, "advisory")
  const revision = field(value, "revision"), rawRequirements = field(value, "requirements")
  const rows = rawRequirements.ok ? denseArray(rawRequirements.value, MAX_REQUIREMENTS) : undefined
  if (!schemaVersion.ok || schemaVersion.value !== TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION
    || !advisory.ok || advisory.value !== true || !revision.ok || !safeRevision(revision.value) || !rows) return null
  const requirements: ObjectiveProgressRequirement[] = []
  for (const value of rows) {
    const row = requirement(value)
    if (!row || requirements.some(existing => existing.id === row.id)) return null
    requirements.push(row)
  }
  if (revision.value === null && requirements.some(row => row.status !== "unknown")) return null
  const snapshot: ObjectiveProgressSnapshot = { schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION,
    advisory: true, revision: revision.value, requirements }
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_ROW_BYTES ? snapshot : null
}

export function objectiveProgressSnapshotFromContext(context: StepContext): ObjectiveProgressSnapshot | null {
  const matches = context.blocks.filter(block => block.id === TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID
    && block.layer === "tool_observation")
  if (matches.length !== 1 || !plain(matches[0]?.content)) return null
  return parseObjectiveProgressSnapshot(matches[0].content)
}

function deltaRows(current: ObjectiveProgressSnapshot | null, previous?: ObjectiveProgressSnapshot): ObjectiveProgressDeltaRequirement[] {
  const byId = new Map(previous?.requirements.map(row => [row.id, row]) ?? [])
  return current?.requirements.map(row => {
    const statuses = { beforeStatus: byId.get(row.id)?.status ?? "unknown", afterStatus: row.status }
    return row.kind === "candidate_location_in" ? { id: row.id, kind: row.kind, ...statuses }
      : { id: row.id, kind: row.kind, minimum: row.minimum, ...statuses }
  }) ?? []
}

function sameRequirementIdentity(previous: ObjectiveProgressRequirement | undefined, current: ObjectiveProgressRequirement): boolean {
  if (!previous || previous.kind !== current.kind) return false
  if (current.kind === "candidate_location_in") {
    return previous.kind === "candidate_location_in" && previous.locations.length === current.locations.length
      && previous.locations.every((location, index) => location === current.locations[index])
  }
  return previous.kind !== "candidate_location_in" && previous.minimum === current.minimum
}

export function taskGraphObjectiveProgressDelta(previous: ObjectiveProgressSnapshot | null,
  current: ObjectiveProgressSnapshot | null, identityMatches: boolean): ObjectiveProgressDelta {
  const previousById = new Map(previous?.requirements.map(row => [row.id, row]) ?? [])
  const matches = Boolean(previous && current && previous.revision !== null && current.revision !== null && identityMatches
    && previous.requirements.length === current.requirements.length
    && previousById.size === current.requirements.length
    && previous.revision <= current.revision
    && current.requirements.every(row => sameRequirementIdentity(previousById.get(row.id), row)))
  if (!matches || !previous || !current) return {
    schemaVersion: "agent-harness.v2.objective-progress-delta.v1", availability: "unavailable",
    previousPlanRevision: null, currentPlanRevision: current?.revision ?? null, requirements: deltaRows(current),
  }
  return { schemaVersion: "agent-harness.v2.objective-progress-delta.v1", availability: "available",
    previousPlanRevision: previous.revision, currentPlanRevision: current.revision,
    requirements: deltaRows(current, previous) }
}

export function parseObjectiveProgressDelta(value: unknown): ObjectiveProgressDelta | null {
  if (!plain(value) || !exact(value, ["schemaVersion", "availability", "previousPlanRevision", "currentPlanRevision", "requirements"])) return null
  const schemaVersion = field(value, "schemaVersion"), availability = field(value, "availability")
  const previousRevision = field(value, "previousPlanRevision"), currentRevision = field(value, "currentPlanRevision")
  const rawRequirements = field(value, "requirements")
  const rows = rawRequirements.ok ? denseArray(rawRequirements.value, MAX_REQUIREMENTS) : undefined
  if (!schemaVersion.ok || schemaVersion.value !== "agent-harness.v2.objective-progress-delta.v1"
    || !availability.ok || availability.value !== "available" && availability.value !== "unavailable"
    || !previousRevision.ok || !safeRevision(previousRevision.value) || !currentRevision.ok || !safeRevision(currentRevision.value)
    || !rows) return null
  const requirements: ObjectiveProgressDeltaRequirement[] = []
  for (const row of rows) {
    if (!plain(row)) return null
    const kind = field(row, "kind"), id = field(row, "id"), before = field(row, "beforeStatus"), after = field(row, "afterStatus")
    if (!kind.ok || !id.ok || !before.ok || !after.ok || !safeId(id.value) || !safeStatus(before.value) || !safeStatus(after.value)
      || requirements.some(existing => existing.id === id.value)) return null
    if (kind.value === "candidate_location_in") {
      if (!exact(row, ["id", "kind", "beforeStatus", "afterStatus"])) return null
      requirements.push({ id: id.value, kind: kind.value, beforeStatus: before.value, afterStatus: after.value })
      continue
    }
    if (!exact(row, ["id", "kind", "minimum", "beforeStatus", "afterStatus"])) return null
    const minimum = field(row, "minimum")
    if (!minimum.ok || typeof kind.value !== "string" || !KINDS.has(kind.value)
      || typeof minimum.value !== "number" || !Number.isSafeInteger(minimum.value) || minimum.value < 1 || minimum.value > 50) return null
    requirements.push({ id: id.value, kind: kind.value as "candidate_count_gte" | "finding_count_gte", minimum: minimum.value,
      beforeStatus: before.value, afterStatus: after.value })
  }
  if (availability.value === "unavailable" && (previousRevision.value !== null
    || requirements.some(row => row.beforeStatus !== "unknown"))) return null
  if (availability.value === "available" && (previousRevision.value === null || currentRevision.value === null
    || previousRevision.value > currentRevision.value)) return null
  const delta: ObjectiveProgressDelta = { schemaVersion: "agent-harness.v2.objective-progress-delta.v1",
    availability: availability.value, previousPlanRevision: previousRevision.value,
    currentPlanRevision: currentRevision.value, requirements }
  return Buffer.byteLength(JSON.stringify(delta), "utf8") <= MAX_ROW_BYTES ? delta : null
}
