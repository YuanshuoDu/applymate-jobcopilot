import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import { isValidTaskGraphRepairRelation, type TaskGraphNodeProposal, type TaskGraphVerificationDisposition } from "./task-graph.js"

export type TaskGraphObjectiveLineageNode = Pick<TaskGraphNodeProposal,
  "key" | "templateId" | "dependsOn" | "verification" | "repairOf"> & Readonly<{
  taskId?: string
  verificationDisposition?: TaskGraphVerificationDisposition
}>
export type TaskGraphObjectiveLineageCriterion = NonNullable<TaskGraphNodeProposal["verification"]>["criteria"][number]
export type TaskGraphObjectiveRequirementLineageSelection<Node extends TaskGraphObjectiveLineageNode = TaskGraphObjectiveLineageNode> =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "selected"; node: Node; criterion: TaskGraphObjectiveLineageCriterion }>
export type TaskGraphObjectiveRequirementLineageMember<Node extends TaskGraphObjectiveLineageNode = TaskGraphObjectiveLineageNode> =
  Readonly<{ node: Node; criterion: TaskGraphObjectiveLineageCriterion }>
export type TaskGraphObjectiveRequirementLineagesSelection<Node extends TaskGraphObjectiveLineageNode = TaskGraphObjectiveLineageNode> =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "selected"; lineages: readonly TaskGraphObjectiveRequirementLineageMember<Node>[] }>

function criterionOccurrences(node: TaskGraphObjectiveLineageNode, id: string): TaskGraphObjectiveLineageCriterion[] {
  return (node.verification?.criteria ?? []).filter(criterion => criterion.id === id)
}

function repairLinkValid(node: TaskGraphObjectiveLineageNode, target: TaskGraphObjectiveLineageNode,
  rootTaskId: string, positions: ReadonlyMap<string, number>): boolean {
  return node.repairOf?.graphRootTaskId === rootTaskId
    && (positions.get(target.key) ?? Number.POSITIVE_INFINITY) < (positions.get(node.key) ?? -1)
    && node.repairOf.taskId === target.taskId
    // The validator reads only the fields in TaskGraphObjectiveLineageNode; its public input type is broader.
    && isValidTaskGraphRepairRelation(node as TaskGraphNodeProposal,
      target as TaskGraphNodeProposal & Readonly<{ taskId?: string; verificationDisposition?: TaskGraphVerificationDisposition }>)
}

/** Selects the latest valid member of each unambiguous repair lineage for one requirement. */
export function selectTaskGraphObjectiveRequirementLineages<Node extends TaskGraphObjectiveLineageNode>(
  requirement: RootTaskVerificationRequirement,
  nodes: readonly Node[],
  rootTaskId: string,
): TaskGraphObjectiveRequirementLineagesSelection<Node> {
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const positions = new Map(nodes.map((node, index) => [node.key, index] as const))
  const malformedLineages = new Set<string>()
  const lineageRoot = (start: Node): string => {
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

  const lineages = new Map<string, Array<Readonly<{ node: Node; index: number }>>>()
  nodes.forEach((node, index) => {
    const occurrences = criterionOccurrences(node, requirement.id)
    if (occurrences.length === 0) return
    const root = lineageRoot(node)
    const members = lineages.get(root) ?? []
    members.push({ node, index })
    lineages.set(root, members)
    if (occurrences.length !== 1) malformedLineages.add(root)
  })

  if (lineages.size === 0) return malformedLineages.size ? { status: "invalid" } : { status: "missing" }
  if (malformedLineages.size !== 0) return { status: "invalid" }
  const selected = [...lineages.values()].map(members => {
    const latest = members.reduce((last, candidate) => candidate.index > last.index ? candidate : last)
    const occurrences = criterionOccurrences(latest.node, requirement.id)
    return occurrences.length === 1 ? { node: latest.node, criterion: occurrences[0]! } : undefined
  })
  return selected.some(member => !member) ? { status: "invalid" }
    : { status: "selected", lineages: selected as TaskGraphObjectiveRequirementLineageMember<Node>[] }
}

/** Selects one exact criterion on one unambiguous repair lineage. */
export function selectTaskGraphObjectiveRequirementLineage<Node extends TaskGraphObjectiveLineageNode>(
  requirement: RootTaskVerificationRequirement,
  nodes: readonly Node[],
  rootTaskId: string,
): TaskGraphObjectiveRequirementLineageSelection<Node> {
  const selected = selectTaskGraphObjectiveRequirementLineages(requirement, nodes, rootTaskId)
  if (selected.status !== "selected") return selected
  return selected.lineages.length === 1
    ? { status: "selected", ...selected.lineages[0]! }
    : { status: "invalid" }
}
