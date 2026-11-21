import type { RootTaskVerificationRequirement, RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { selectTaskGraphObjectiveRequirementLineage, selectTaskGraphObjectiveRequirementLineages, type TaskGraphObjectiveLineageNode } from "./task-graph-objective-lineage.js"
import type { TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"

export type TaskGraphObjectiveCoverageRejection =
  | Readonly<{ id: string; kind: "candidate_location_in"; role: "scout"; locations: readonly string[] }>
  | Readonly<{ id: string; kind: "candidate_count_gte"; role: "scout"; minimum: number }>
  | Readonly<{ id: string; kind: "finding_count_gte"; role: "analyst"; minimum: number }>

export type TaskGraphObjectiveCoverageResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "covered" }>
  | Readonly<{ status: "incomplete"; requirements: readonly TaskGraphObjectiveCoverageRejection[] }>

type CoverageNode = TaskGraphObjectiveLineageNode
type NumericObjectiveRequirement = Extract<RootTaskVerificationRequirement, { minimum: number }>

function expectedRole(kind: RootTaskVerificationRequirement["kind"]): TaskGraphObjectiveCoverageRejection["role"] {
  return kind === "finding_count_gte" ? "analyst" : "scout"
}

function sameLocations(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((location, index) => location === right[index])
}

function everyScoutCoversLocation(
  requirement: Extract<RootTaskVerificationRequirement, { kind: "candidate_location_in" }>,
  nodes: readonly CoverageNode[],
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>,
): boolean {
  const scouts = nodes.filter(node => templates[node.templateId]?.role === "scout")
  if (scouts.length === 0) return false
  if (nodes.some(node => templates[node.templateId]?.role !== "scout"
    && node.verification?.criteria.some(criterion => criterion.id === requirement.id))) return false
  return scouts.every(node => {
    const verification = node.verification
    if (verification?.role !== "scout") return false
    const criteria = verification.criteria.filter(criterion => criterion.id === requirement.id)
    return criteria.length === 1 && criteria[0]?.check.kind === "candidate_location_in"
      && sameLocations(criteria[0].check.locations, requirement.locations)
  })
}

function analystsCoverFindingCount(
  requirement: NumericObjectiveRequirement,
  nodes: readonly CoverageNode[],
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>,
  rootTaskId: string,
): boolean {
  if (requirement.kind !== "finding_count_gte") return false
  const selected = selectTaskGraphObjectiveRequirementLineages(requirement, nodes, rootTaskId)
  if (selected.status !== "selected") return false
  if (selected.lineages.length === 1) {
    const { node, criterion } = selected.lineages[0]!
    return node.verification?.role === "analyst" && templates[node.templateId]?.role === "analyst"
      && criterion.check.kind === "finding_count_gte" && criterion.check.minimum >= requirement.minimum
  }
  let minimum = 0
  for (const { node, criterion } of selected.lineages) {
    const check = criterion.check
    if (node.templateId !== "analyst" || node.verification?.role !== "analyst"
      || templates[node.templateId]?.role !== "analyst" || check.kind !== "finding_count_gte"
      || !Number.isSafeInteger(check.minimum) || check.minimum < 1) return false
    minimum += check.minimum
  }
  return minimum >= requirement.minimum
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
    const covered = requirement.kind === "candidate_location_in"
      ? everyScoutCoversLocation(requirement, nodes, templates)
      : requirement.kind === "finding_count_gte"
        ? analystsCoverFindingCount(requirement, nodes, templates, rootTaskId)
      : (() => {
        const selected = selectTaskGraphObjectiveRequirementLineage(requirement, nodes, rootTaskId)
        const check = selected.status === "selected" ? selected.criterion.check : undefined
        return selected.status === "selected"
          && selected.node.verification?.role === role
          && templates[selected.node.templateId]?.role === role
          && check?.kind === requirement.kind && check.minimum >= requirement.minimum
      })()
    if (!covered) {
      if (requirement.kind === "candidate_location_in") missing.push({ id: requirement.id, kind: requirement.kind, role: "scout", locations: requirement.locations })
      else if (requirement.kind === "candidate_count_gte") missing.push({ id: requirement.id, kind: requirement.kind, role: "scout", minimum: requirement.minimum })
      else missing.push({ id: requirement.id, kind: requirement.kind, role: "analyst", minimum: requirement.minimum })
    }
  }
  return missing.length ? { status: "incomplete", requirements: missing } : { status: "covered" }
}
