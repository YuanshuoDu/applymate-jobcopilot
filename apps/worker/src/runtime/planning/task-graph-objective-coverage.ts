import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { selectTaskGraphObjectiveRequirementLineage, type TaskGraphObjectiveLineageNode } from "./task-graph-objective-lineage.js"
import type { TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"

export type TaskGraphObjectiveCoverageRejection = Readonly<{
  id: string
  kind: "candidate_count_gte" | "finding_count_gte"
  role: "scout" | "analyst"
  minimum: number
}>

export type TaskGraphObjectiveCoverageResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "covered" }>
  | Readonly<{ status: "incomplete"; requirements: readonly TaskGraphObjectiveCoverageRejection[] }>

type CoverageNode = TaskGraphObjectiveLineageNode

function expectedRole(kind: TaskGraphObjectiveCoverageRejection["kind"]): TaskGraphObjectiveCoverageRejection["role"] {
  return kind === "candidate_count_gte" ? "scout" : "analyst"
}

/** Checks a complete post-append graph against requirements resolved from the persisted canonical Turn input.
 * Call only after the scheduler has validated every proposed repair target under its existing transaction locks.
 */
export function evaluateTaskGraphObjectiveCoverage(
  resolution: RootTaskVerificationRequirementsResolution,
  nodes: readonly CoverageNode[],
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>,
  rootTaskId: string,
): TaskGraphObjectiveCoverageResult {
  if (resolution.status === "absent") return { status: "absent" }
  if (resolution.status === "invalid") return { status: "invalid" }

  const missing: TaskGraphObjectiveCoverageRejection[] = []
  for (const requirement of resolution.requirements) {
    const role = expectedRole(requirement.kind)
    const selected = selectTaskGraphObjectiveRequirementLineage(requirement, nodes, rootTaskId)
    const check = selected.status === "selected" ? selected.criterion.check : undefined
    const covered = selected.status === "selected"
      && selected.node.verification?.role === role
      && templates[selected.node.templateId]?.role === role
      && check?.kind === requirement.kind
      && check.minimum >= requirement.minimum
    if (!covered) missing.push({ id: requirement.id, kind: requirement.kind, role, minimum: requirement.minimum })
  }
  return missing.length ? { status: "incomplete", requirements: missing } : { status: "covered" }
}
