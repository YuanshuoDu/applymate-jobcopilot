import {
  OBJECTIVE_TAILOR_SOURCE_GROUPS_FIELD,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA,
  parseObjectiveTailorFinalOutcomeSidecar,
  type ObjectiveTailorFinalOutcomeSidecarV3,
  type ObjectiveTailorSourceGroups,
} from "@jobcopilot/agent-protocol"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { hasObjectiveTailorFinalOutcome, readBoundObjectiveTailorFinalOutcome } from "./objective-tailor-final-summary-binding.js"
import { readObjectiveTailorSourceGroups } from "./objective-tailor-source-groups.js"

export type ObjectiveTailorFinalOutcomeSidecarRead =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "ready"; sidecar: ObjectiveTailorFinalOutcomeSidecarV3 }>

export type TaskGraphFinalSidecars = Readonly<{
  taskGraphSources?: Exclude<ReturnType<typeof buildTaskGraphFinalSourceManifest>, null>
  objectiveTailorFinalOutcomes?: ObjectiveTailorFinalOutcomeSidecarV3
  [OBJECTIVE_TAILOR_SOURCE_GROUPS_FIELD]?: ObjectiveTailorSourceGroups
}>

export function readObjectiveTailorFinalOutcomeSidecar(value: unknown): ObjectiveTailorFinalOutcomeSidecarRead {
  if (!hasObjectiveTailorFinalOutcome(value)) return { status: "absent" }
  const outcome = readBoundObjectiveTailorFinalOutcome(value)
  if (!outcome) return { status: "invalid" }
  const sourceCounts = readSourceCounts(value, outcome.graphRevision)
  if (!sourceCounts) return { status: "invalid" }
  const floor = outcome.reportedScoreFloor ?? { status: "unavailable" as const }
  const reportedScoreFloor = floor.status === "complete"
    ? { status: "complete" as const, minimumScore: floor.minimumScore,
      qualifyingJobCount: floor.qualifyingJobCount } : { status: floor.status }
  const sidecar = parseObjectiveTailorFinalOutcomeSidecar({
    schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA,
    graphRevision: outcome.graphRevision,
    slots: outcome.slots.map(slot => ({ ordinal: slot.ordinal, status: slot.status })),
    sourceCounts,
    reportedScoreFloor,
  })
  return sidecar?.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA
    ? { status: "ready", sidecar } : { status: "invalid" }
}

export function objectiveTailorFinalOutcomeSidecarMatches(binding: unknown, value: unknown): boolean {
  const read = readObjectiveTailorFinalOutcomeSidecar(binding)
  if (read.status === "invalid") return false
  if (read.status === "absent") return value === undefined
  const parsed = parseObjectiveTailorFinalOutcomeSidecar(value)
  return Boolean(parsed?.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA && sameSidecar(read.sidecar, parsed))
}

export function buildTaskGraphFinalSidecars(binding: TaskGraphFinalSummaryBinding, finalItemId: string): TaskGraphFinalSidecars | null {
  const taskGraphSources = buildTaskGraphFinalSourceManifest(binding, finalItemId)
  const outcome = readObjectiveTailorFinalOutcomeSidecar(binding)
  if (outcome.status === "invalid") throw new Error("objective_tailor_final_outcome_invalid")
  const sourceGroups = readObjectiveTailorSourceGroups(binding, finalItemId)
  if (sourceGroups.status === "invalid") throw new Error("objective_tailor_source_groups_invalid")
  if (!taskGraphSources && outcome.status !== "ready") return null
  return {
    ...(taskGraphSources ? { taskGraphSources } : {}),
    ...(outcome.status === "ready" ? { objectiveTailorFinalOutcomes: outcome.sidecar } : {}),
    ...(sourceGroups.status === "ready" ? { [OBJECTIVE_TAILOR_SOURCE_GROUPS_FIELD]: sourceGroups.groups } : {}),
  }
}

function sameSidecar(left: ObjectiveTailorFinalOutcomeSidecarV3, right: ObjectiveTailorFinalOutcomeSidecarV3): boolean {
  return left.graphRevision === right.graphRevision && left.slots.length === right.slots.length
    && left.slots.every((slot, index) => slot.ordinal === right.slots[index]?.ordinal && slot.status === right.slots[index]?.status)
    && sameCount(left.sourceCounts.discoveredJobs, right.sourceCounts.discoveredJobs)
    && sameCount(left.sourceCounts.analyzedJobs, right.sourceCounts.analyzedJobs)
    && JSON.stringify(left.reportedScoreFloor) === JSON.stringify(right.reportedScoreFloor)
}

function readSourceCounts(value: unknown, graphRevision: number): Readonly<{ discoveredJobs: unknown; analyzedJobs: unknown }> | null {
  const binding = record(value), summary = record(binding?.summary), counts = record(summary?.counts)
  if (!summary || summary.graphRevision !== graphRevision || !counts) return null
  return { discoveredJobs: counts.discoveredJobs, analyzedJobs: counts.analyzedJobs }
}

function sameCount(left: ObjectiveTailorFinalOutcomeSidecarV3["sourceCounts"]["discoveredJobs"], right: ObjectiveTailorFinalOutcomeSidecarV3["sourceCounts"]["discoveredJobs"]): boolean {
  return left.knownCount === right.knownCount && left.coverage === right.coverage
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown> : null
  } catch { return null }
}
