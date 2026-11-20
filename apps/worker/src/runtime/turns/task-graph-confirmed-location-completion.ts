import type pg from "pg"
import { resolveRootTaskVerificationRequirements, type RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { evaluateTaskGraphObjectiveCoverage } from "../planning/task-graph-objective-coverage.js"
import type { TaskGraphObjectiveLineageNode } from "../planning/task-graph-objective-lineage.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { buildTaskGraphLocationCoverageNodes, canRetainCompatiblePriorScouts,
  type TaskGraphAvailableLocationEvidence } from "../subagents/task-graph-plan-objective-coverage.js"
import { resolveTaskGraphCurrentLocationEvidence } from "../subagents/task-graph-current-location-evidence.js"
import type { TaskGraphConfirmedLocationSteerResult } from "../subagents/task-graph-confirmed-location-steer.js"
import type { SteeringReconciliationState } from "../subagents/steering-reconciliation-contract.js"
import type { GraphIdentityScope, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { taskGraphCompletionApplicability } from "./task-graph-completion-applicability.js"

type Client = Pick<pg.PoolClient, "query">
type Available = Extract<TaskGraphAvailableLocationEvidence, { status: "available" }>
export type TaskGraphConfirmedLocationCompletionResult = Readonly<{ kind: "absent" | "pending" | "unavailable" | "replan" }>
  | Readonly<{ kind: "applicable"; historicalNodeIndices: ReadonlySet<number> }>
export type TaskGraphConfirmedLocationCompletionInput = Readonly<{
  client: Client
  loaded: LoadedGraph
  scope: GraphIdentityScope
  reconciliation: SteeringReconciliationState
  confirmed: TaskGraphConfirmedLocationSteerResult
  persistedTurnInput: unknown
  verifiedCompletedTaskIds: ReadonlySet<string>
  retiredNodeKeys?: ReadonlySet<string>
}>

const ABSENT: TaskGraphConfirmedLocationCompletionResult = Object.freeze({ kind: "absent" })
const PENDING: TaskGraphConfirmedLocationCompletionResult = Object.freeze({ kind: "pending" })
const UNAVAILABLE: TaskGraphConfirmedLocationCompletionResult = Object.freeze({ kind: "unavailable" })
const REPLAN: TaskGraphConfirmedLocationCompletionResult = Object.freeze({ kind: "replan" })

/** Applies typed location scope only after its acceptance and reconciliation cutoff are rebound. */
export async function resolveTaskGraphConfirmedLocationCompletion(
  input: TaskGraphConfirmedLocationCompletionInput,
): Promise<TaskGraphConfirmedLocationCompletionResult> {
  try {
    if (!input || typeof input !== "object") return UNAVAILABLE
    const { confirmed, reconciliation, loaded, scope } = input
    if (confirmed.kind === "absent") return ABSENT
    if (confirmed.kind === "pending") return PENDING
    if (confirmed.kind !== "confirmed") return UNAVAILABLE
    const cursor = reconciliation.lastReconciledInputThroughSequence
    if (typeof cursor !== "bigint" || cursor < 0n || cursor > 9_223_372_036_854_775_807n) return UNAVAILABLE
    if (cursor < confirmed.acceptedInputSequence) return PENDING
    const revision = loaded.item?.revision
    if (!loaded.snapshot || !Number.isSafeInteger(revision) || Number(revision) < 1
      || reconciliation.currentRevision !== revision) return REPLAN

    const initialRequirements: RootTaskVerificationRequirementsResolution = resolveRootTaskVerificationRequirements(input.persistedTurnInput)
    const evidence = await resolveTaskGraphCurrentLocationEvidence({
      client: input.client, loaded, scope, initialRequirements, verifiedCurrentLocations: confirmed.locations,
      acceptedInputSequence: confirmed.acceptedInputSequence,
      retainCompatiblePriorScouts: canRetainCompatiblePriorScouts(reconciliation, confirmed.acceptedInputSequence),
      retiredNodeKeys: input.retiredNodeKeys,
    })
    if (evidence.status !== "available") return UNAVAILABLE
    if (input.retiredNodeKeys?.size && !reconciliation.latestUserRevision) return REPLAN
    const historicalNodeIndices = new Set<number>()
    if (reconciliation.latestUserRevision) {
      const applicable = taskGraphCompletionApplicability(loaded, reconciliation.latestUserRevision, Number(revision),
        input.verifiedCompletedTaskIds, evidence.compatibleRetainedNodeKeys, input.retiredNodeKeys)
      if (applicable.kind === "replan") return REPLAN
      for (const index of applicable.historicalNodeIndices) historicalNodeIndices.add(index)
    }
    const positions = new Map(loaded.snapshot.nodes.map((node, index) => [node.key, index] as const))
    for (const key of evidence.excludedHistoricalNodeKeys) {
      const index = positions.get(key)
      if (index === undefined) return UNAVAILABLE
      historicalNodeIndices.add(index)
    }
    const historicalKeys = new Set(loaded.snapshot.nodes.flatMap((node, index) => historicalNodeIndices.has(index) ? [node.key] : []))
    const retiredKeys = input.retiredNodeKeys ?? new Set<string>()
    const excludedKeys = new Set([...historicalKeys, ...retiredKeys])
    if (dependsOnExcludedScout(loaded.snapshot.nodes, historicalNodeIndices, excludedKeys)) return REPLAN
    if (!objectiveCovered(loaded.snapshot.nodes, evidence, historicalNodeIndices, retiredKeys, scope.rootTaskId)) return REPLAN
    return { kind: "applicable", historicalNodeIndices }
  } catch {
    return UNAVAILABLE
  }
}

function objectiveCovered(
  nodes: readonly TaskGraphObjectiveLineageNode[], evidence: Available,
  historical: ReadonlySet<number>, retired: ReadonlySet<string>, rootTaskId: string,
): boolean {
  if (evidence.effectiveRequirements.requirements.filter(item => item.kind === "candidate_location_in").length !== 1) return false
  const selectedNodes = nodes.filter((node, index) => !historical.has(index) && !retired.has(node.key))
  const projected = buildTaskGraphLocationCoverageNodes(selectedNodes, evidence)
  return evaluateTaskGraphObjectiveCoverage(evidence.effectiveRequirements, projected, TASK_GRAPH_TEMPLATES, rootTaskId).status === "covered"
}

function dependsOnExcludedScout(
  nodes: readonly TaskGraphObjectiveLineageNode[], historicalIndices: ReadonlySet<number>, historicalKeys: ReadonlySet<string>,
): boolean {
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const reaches = (key: string, seen: ReadonlySet<string>): boolean => {
    if (historicalKeys.has(key)) return true
    if (seen.has(key)) return false
    const node = byKey.get(key)
    if (!node) return false
    const next = new Set(seen).add(key)
    return node.dependsOn.some(dependency => reaches(dependency, next))
      || Boolean(node.repairOf && reaches(node.repairOf.nodeKey, next))
  }
  return nodes.some((node, index) => !historicalIndices.has(index)
    && (node.dependsOn.some(key => reaches(key, new Set())) || Boolean(node.repairOf && reaches(node.repairOf.nodeKey, new Set()))))
}
