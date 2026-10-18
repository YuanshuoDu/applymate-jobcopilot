import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { isValidTaskGraphRepairRelation, type TaskGraphNodeProposal, type TaskGraphVerificationDisposition } from "./task-graph.js"
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

type CoverageNode = TaskGraphNodeProposal & Readonly<{
  taskId?: string
  verificationDisposition?: TaskGraphVerificationDisposition
}>

function expectedRole(kind: TaskGraphObjectiveCoverageRejection["kind"]): TaskGraphObjectiveCoverageRejection["role"] {
  return kind === "candidate_count_gte" ? "scout" : "analyst"
}

function criterionOccurrences(node: CoverageNode, id: string) {
  return (node.verification?.criteria ?? []).filter(criterion => criterion.id === id)
}

function repairLinkValid(node: CoverageNode, target: CoverageNode, rootTaskId: string, positions: ReadonlyMap<string, number>): boolean {
  return node.repairOf?.graphRootTaskId === rootTaskId
    && (positions.get(target.key) ?? Number.POSITIVE_INFINITY) < (positions.get(node.key) ?? -1)
    && node.repairOf.taskId === target.taskId
    && isValidTaskGraphRepairRelation(node, target)
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

  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const positions = new Map(nodes.map((node, index) => [node.key, index] as const))
  const missing: TaskGraphObjectiveCoverageRejection[] = []
  for (const requirement of resolution.requirements) {
    const role = expectedRole(requirement.kind)
    const malformedLineages = new Set<string>()
    const lineageRoot = (start: CoverageNode): string => {
      let node = start
      const visited = new Set<string>()
      while (node.repairOf?.criterionIds.includes(requirement.id)) {
        if (visited.has(node.key)) return node.key
        visited.add(node.key)
        const target = byKey.get(node.repairOf.nodeKey)
        if (!target || !repairLinkValid(node, target, rootTaskId, positions)) return target?.key ?? node.key
        node = target
      }
      return node.key
    }

    for (const node of nodes) {
      const relation = node.repairOf
      if (!relation) continue
      const ownCriteria = criterionOccurrences(node, requirement.id)
      if (!relation.criterionIds.includes(requirement.id) && ownCriteria.length === 0) continue
      const target = byKey.get(relation.nodeKey)
      if (!target || !repairLinkValid(node, target, rootTaskId, positions)) {
        malformedLineages.add(target ? lineageRoot(target) : node.key)
      }
    }

    const lineages = new Map<string, Array<Readonly<{ node: CoverageNode; index: number }>>>()
    nodes.forEach((node, index) => {
      const occurrences = criterionOccurrences(node, requirement.id)
      if (occurrences.length === 0) return
      const root = lineageRoot(node)
      const members = lineages.get(root) ?? []
      members.push({ node, index })
      lineages.set(root, members)
      if (occurrences.length !== 1) malformedLineages.add(root)
    })

    const onlyLineage = lineages.size === 1 ? [...lineages.values()][0] : undefined
    const latest = onlyLineage?.reduce((last, candidate) => candidate.index > last.index ? candidate : last)
    const criterion = latest && criterionOccurrences(latest.node, requirement.id)[0]
    const check = criterion?.check
    const covered = lineages.size === 1 && malformedLineages.size === 0
      && latest?.node.verification?.role === role
      && templates[latest.node.templateId]?.role === role
      && check?.kind === requirement.kind
      && check.minimum >= requirement.minimum
    if (!covered) missing.push({ id: requirement.id, kind: requirement.kind, role, minimum: requirement.minimum })
  }
  return missing.length ? { status: "incomplete", requirements: missing } : { status: "covered" }
}
