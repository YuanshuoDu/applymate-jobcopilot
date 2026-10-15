import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import type { TaskGraphProposal } from "./task-graph.js"
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

/** Checks only requirements resolved from the persisted canonical Turn input. */
export function evaluateTaskGraphObjectiveCoverage(
  resolution: RootTaskVerificationRequirementsResolution,
  proposal: TaskGraphProposal,
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>,
): TaskGraphObjectiveCoverageResult {
  if (resolution.status === "absent") return { status: "absent" }
  if (resolution.status === "invalid") return { status: "invalid" }

  const missing: TaskGraphObjectiveCoverageRejection[] = []
  for (const requirement of resolution.requirements) {
    const role = requirement.kind === "candidate_count_gte" ? "scout" : "analyst"
    const matches = proposal.nodes.flatMap(node => (node.verification?.criteria ?? [])
      .filter(criterion => criterion.id === requirement.id)
      .map(criterion => ({ node, criterion })))
    const match = matches[0]
    const check = match?.criterion.check
    const covered = matches.length === 1
      && match?.node.verification?.role === role
      && templates[match.node.templateId]?.role === role
      && check?.kind === requirement.kind
      && check.minimum >= requirement.minimum
    if (!covered) missing.push({ id: requirement.id, kind: requirement.kind, role, minimum: requirement.minimum })
  }
  return missing.length ? { status: "incomplete", requirements: missing } : { status: "covered" }
}
