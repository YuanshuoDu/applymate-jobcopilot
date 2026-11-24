import {
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
  parseObjectiveTailorFinalOutcomeSidecar,
  type ObjectiveTailorFinalOutcomeSidecar,
} from "@jobcopilot/agent-protocol"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { hasObjectiveTailorFinalOutcome, readBoundObjectiveTailorFinalOutcome } from "./objective-tailor-final-summary-binding.js"

export type ObjectiveTailorFinalOutcomeSidecarRead =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "ready"; sidecar: ObjectiveTailorFinalOutcomeSidecar }>

export type TaskGraphFinalSidecars = Readonly<{
  taskGraphSources?: Exclude<ReturnType<typeof buildTaskGraphFinalSourceManifest>, null>
  objectiveTailorFinalOutcomes?: ObjectiveTailorFinalOutcomeSidecar
}>

export function readObjectiveTailorFinalOutcomeSidecar(value: unknown): ObjectiveTailorFinalOutcomeSidecarRead {
  if (!hasObjectiveTailorFinalOutcome(value)) return { status: "absent" }
  const outcome = readBoundObjectiveTailorFinalOutcome(value)
  if (!outcome) return { status: "invalid" }
  const sidecar = parseObjectiveTailorFinalOutcomeSidecar({
    schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
    slots: outcome.slots.map(slot => ({ ordinal: slot.ordinal, status: slot.status })),
  })
  return sidecar ? { status: "ready", sidecar } : { status: "invalid" }
}

export function objectiveTailorFinalOutcomeSidecarMatches(binding: unknown, value: unknown): boolean {
  const read = readObjectiveTailorFinalOutcomeSidecar(binding)
  if (read.status === "invalid") return false
  if (read.status === "absent") return value === undefined
  const parsed = parseObjectiveTailorFinalOutcomeSidecar(value)
  return Boolean(parsed && sameSidecar(read.sidecar, parsed))
}

export function buildTaskGraphFinalSidecars(binding: TaskGraphFinalSummaryBinding, finalItemId: string): TaskGraphFinalSidecars | null {
  const taskGraphSources = buildTaskGraphFinalSourceManifest(binding, finalItemId)
  const outcome = readObjectiveTailorFinalOutcomeSidecar(binding)
  if (outcome.status === "invalid") throw new Error("objective_tailor_final_outcome_invalid")
  if (!taskGraphSources && outcome.status !== "ready") return null
  return {
    ...(taskGraphSources ? { taskGraphSources } : {}),
    ...(outcome.status === "ready" ? { objectiveTailorFinalOutcomes: outcome.sidecar } : {}),
  }
}

function sameSidecar(left: ObjectiveTailorFinalOutcomeSidecar, right: ObjectiveTailorFinalOutcomeSidecar): boolean {
  return left.schemaVersion === right.schemaVersion && left.slots.length === right.slots.length
    && left.slots.every((slot, index) => slot.ordinal === right.slots[index]?.ordinal && slot.status === right.slots[index]?.status)
}
