import { Buffer } from "node:buffer"

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
}>
export type ObjectiveProgressSnapshot = Readonly<{
  schemaVersion: typeof TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION
  advisory: true
  revision: number | null
  requirements: readonly ObjectiveProgressRequirement[]
}>
export type ObjectiveProgressDeltaRequirement = Omit<ObjectiveProgressRequirement, "status"> & {
  beforeStatus: TaskGraphObjectiveProgressStatus
  afterStatus: TaskGraphObjectiveProgressStatus
}
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
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function safeRevision(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function requirement(value: unknown): ObjectiveProgressRequirement | undefined {
  if (!plain(value) || !exact(value, ["id", "kind", "minimum", "status"])) return undefined
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.id)
    || typeof value.kind !== "string" || !KINDS.has(value.kind)
    || typeof value.minimum !== "number" || !Number.isSafeInteger(value.minimum) || value.minimum < 1 || value.minimum > 50
    || typeof value.status !== "string" || !STATUSES.has(value.status as TaskGraphObjectiveProgressStatus)) return undefined
  return { id: value.id, kind: value.kind as ObjectiveProgressRequirement["kind"], minimum: value.minimum,
    status: value.status as TaskGraphObjectiveProgressStatus }
}

/** Copies only the existing bounded projection from one exact current-context observation. */
export function parseObjectiveProgressSnapshot(value: unknown): ObjectiveProgressSnapshot | null {
  if (!plain(value) || !exact(value, ["schemaVersion", "advisory", "revision", "requirements"])
    || value.schemaVersion !== TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION || value.advisory !== true || !safeRevision(value.revision)
    || !Array.isArray(value.requirements) || value.requirements.length > MAX_REQUIREMENTS
    || Reflect.ownKeys(value.requirements).length !== value.requirements.length + 1) return null
  const requirements: ObjectiveProgressRequirement[] = []
  for (let index = 0; index < value.requirements.length; index += 1) {
    if (!Object.hasOwn(value.requirements, index)) return null
    const row = requirement(value.requirements[index])
    if (!row || requirements.some(existing => existing.id === row.id)) return null
    requirements.push(row)
  }
  if (value.revision === null && requirements.some(row => row.status !== "unknown")) return null
  const snapshot: ObjectiveProgressSnapshot = { schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION,
    advisory: true, revision: value.revision, requirements }
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
  return current?.requirements.map(row => ({ id: row.id, kind: row.kind, minimum: row.minimum,
    beforeStatus: byId.get(row.id)?.status ?? "unknown", afterStatus: row.status })) ?? []
}

export function taskGraphObjectiveProgressDelta(previous: ObjectiveProgressSnapshot | null,
  current: ObjectiveProgressSnapshot | null, identityMatches: boolean): ObjectiveProgressDelta {
  const previousById = new Map(previous?.requirements.map(row => [row.id, row]) ?? [])
  const matches = Boolean(previous && current && previous.revision !== null && current.revision !== null && identityMatches
    && previous.requirements.length === current.requirements.length
    && previousById.size === current.requirements.length
    && current.requirements.every(row => {
      const prior = previousById.get(row.id)
      return prior?.kind === row.kind && prior.minimum === row.minimum
    }))
  if (!matches || !previous || !current) return {
    schemaVersion: "agent-harness.v2.objective-progress-delta.v1", availability: "unavailable",
    previousPlanRevision: null, currentPlanRevision: current?.revision ?? null, requirements: deltaRows(current),
  }
  return { schemaVersion: "agent-harness.v2.objective-progress-delta.v1", availability: "available",
    previousPlanRevision: previous.revision, currentPlanRevision: current.revision,
    requirements: deltaRows(current, previous) }
}

export function parseObjectiveProgressDelta(value: unknown): ObjectiveProgressDelta | null {
  if (!plain(value) || !exact(value, ["schemaVersion", "availability", "previousPlanRevision", "currentPlanRevision", "requirements"])
    || value.schemaVersion !== "agent-harness.v2.objective-progress-delta.v1"
    || value.availability !== "available" && value.availability !== "unavailable"
    || !safeRevision(value.previousPlanRevision) || !safeRevision(value.currentPlanRevision)
    || !Array.isArray(value.requirements) || value.requirements.length > MAX_REQUIREMENTS
    || Reflect.ownKeys(value.requirements).length !== value.requirements.length + 1) return null
  const requirements: ObjectiveProgressDeltaRequirement[] = []
  for (let index = 0; index < value.requirements.length; index += 1) {
    const row = value.requirements[index]
    if (!plain(row) || !exact(row, ["id", "kind", "minimum", "beforeStatus", "afterStatus"])) return null
    const before = row.beforeStatus, after = row.afterStatus
    const base = requirement({ id: row.id, kind: row.kind, minimum: row.minimum, status: after })
    if (!Object.hasOwn(value.requirements, index) || !base || typeof before !== "string" || !STATUSES.has(before as TaskGraphObjectiveProgressStatus)) return null
    requirements.push({ id: base.id, kind: base.kind, minimum: base.minimum,
      beforeStatus: before as TaskGraphObjectiveProgressStatus, afterStatus: base.status })
  }
  if (value.availability === "unavailable" && (value.previousPlanRevision !== null
    || requirements.some(row => row.beforeStatus !== "unknown"))) return null
  const delta: ObjectiveProgressDelta = { schemaVersion: "agent-harness.v2.objective-progress-delta.v1",
    availability: value.availability, previousPlanRevision: value.previousPlanRevision,
    currentPlanRevision: value.currentPlanRevision, requirements }
  return Buffer.byteLength(JSON.stringify(delta), "utf8") <= MAX_ROW_BYTES ? delta : null
}
