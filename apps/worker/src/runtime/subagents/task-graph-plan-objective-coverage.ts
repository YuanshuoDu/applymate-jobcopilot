import type pg from "pg"
import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { evaluateTaskGraphObjectiveCoverage, type TaskGraphObjectiveCoverageResult } from "../planning/task-graph-objective-coverage.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import type { TaskGraphObjectiveLineageNode } from "../planning/task-graph-objective-lineage.js"
import { loadTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import { readTaskGraphConfirmedLocationSteer } from "./task-graph-confirmed-location-steer.js"
import { resolveTaskGraphCurrentLocationEvidence, type TaskGraphCurrentLocationEvidenceResult } from "./task-graph-current-location-evidence.js"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import type { SteeringReconciliationState } from "./steering-reconciliation-contract.js"
import type { PreparedSteeringReconciliation } from "./steering-reconciliation-contract.js"
import { classifyPendingSupersededScouts } from "./task-graph-pending-scout-scope.js"

type Client = Pick<pg.PoolClient, "query">
export type TaskGraphAvailableLocationEvidence = Extract<TaskGraphCurrentLocationEvidenceResult, { status: "available" }>
type CoverageInput = Readonly<{
  client: Client
  input: TaskGraphScheduleInput
  nodes: readonly TaskGraphObjectiveLineageNode[]
  provenance?: Pick<LoadedGraph, "sourceInputCheckpointByNodeKey" | "currentInputCheckpoint">
  prepared?: PreparedSteeringReconciliation
}>

/** Applies confirmed current-location authority before evaluating a proposed plan's objective coverage. */
export async function evaluateTaskGraphPlanObjectiveCoverage(input: CoverageInput): Promise<TaskGraphObjectiveCoverageResult> {
  const requirements = input.input.verificationRequirements ?? { status: "absent" as const }
  const defaultCoverage = () => evaluateTaskGraphObjectiveCoverage(requirements, input.nodes, input.input.templates, input.input.scope.rootTaskId)
  // Production scheduling supplies the loaded graph; direct in-memory callers keep the legacy coverage path.
  if (!input.provenance) return defaultCoverage()

  const steerScope = {
    userId: input.input.scope.userId, sessionId: input.input.scope.sessionId,
    turnId: input.input.scope.turnId, rootTaskId: input.input.scope.rootTaskId,
  }
  const probe = await readTaskGraphConfirmedLocationSteer(input.client, steerScope,
    input.provenance.currentInputCheckpoint?.inputThroughSequence ?? 0n)
  if (probe.kind === "absent") return defaultCoverage()
  if (probe.kind === "unavailable") return unavailable("task_graph_current_location_steer_unavailable")
  const reconciliation = await readSteeringReconciliationState(input.client, input.input.scope)
  const cutoff = reconciliation.decisionInputThroughSequence
  if (cutoff === null) return unavailable("task_graph_current_location_steer_unavailable")
  const steer = await readTaskGraphConfirmedLocationSteer(input.client, steerScope, cutoff)
  if (steer.kind === "pending") return unavailable("task_graph_current_location_steer_pending")
  if (steer.kind !== "confirmed") return unavailable("task_graph_current_location_steer_unavailable")
  const loaded = await loadTaskGraph(input.client, input.input.scope, false, {
    includeSourceProvenance: true, currentStepId: input.input.scope.stepId,
    currentStepAttempt: 1,
  })
  const pending = input.prepared
    ? classifyPendingSupersededScouts({ loaded, scope: input.input.scope, reconciliation, prepared: input.prepared,
      confirmed: steer, expectedRevision: input.input.proposal.expectedRevision, nodes: input.nodes })
    : { status: "available" as const, pendingNodeKeys: new Set<string>() }
  const pendingNodeKeys = pending.status === "available" ? pending.pendingNodeKeys : new Set<string>()
  const evidence = await resolveTaskGraphCurrentLocationEvidence({
    client: input.client, loaded, scope: input.input.scope, initialRequirements: requirements,
    verifiedCurrentLocations: steer.locations, acceptedInputSequence: steer.acceptedInputSequence,
    retainCompatiblePriorScouts: canRetainCompatiblePriorScouts(reconciliation, steer.acceptedInputSequence),
    pendingSupersededNodeKeys: pendingNodeKeys,
  })
  if (evidence.status !== "available") return unavailable("task_graph_current_location_evidence_unavailable")
  assertNoExcludedScoutDependencies(input.nodes, input.input.proposal.nodes.map(node => node.key), evidence.excludedHistoricalNodeKeys)
  const coverageNodes = buildTaskGraphLocationCoverageNodes(input.nodes, evidence)
    .filter(node => !pendingNodeKeys.has(node.key))
  return evaluateTaskGraphObjectiveCoverage(evidence.effectiveRequirements,
    coverageNodes, input.input.templates, input.input.scope.rootTaskId)
}

export function canRetainCompatiblePriorScouts(state: SteeringReconciliationState, acceptedSequence: bigint): boolean {
  const lastReconciled = state.lastReconciledInputThroughSequence
  const latest = state.latestUserRevision
  if (state.unresolvedInputs.length === 0 && latest === undefined
    && lastReconciled !== undefined && lastReconciled >= acceptedSequence) return true
  const solePendingSteer = state.unresolvedInputs.length === 1
    && state.unresolvedInputs[0]?.acceptedSequence === acceptedSequence
  if (solePendingSteer && latest === undefined && (lastReconciled === undefined || lastReconciled < acceptedSequence)) return true
  return state.unresolvedInputs.length === 0 && latest?.soleSteerSequence === acceptedSequence
    && latest.previousUserRevisionInputThroughSequence === undefined && latest.inputThroughSequence >= acceptedSequence
    && lastReconciled !== undefined && lastReconciled >= latest.inputThroughSequence
}

/** Builds an ephemeral active-node view; it never mutates persisted or proposed TaskGraph nodes. */
export function buildTaskGraphLocationCoverageNodes(
  nodes: readonly TaskGraphObjectiveLineageNode[], evidence: TaskGraphAvailableLocationEvidence,
): TaskGraphObjectiveLineageNode[] {
  const requirement = evidence.effectiveRequirements.requirements.find(item => item.kind === "candidate_location_in")
  if (!requirement || requirement.kind !== "candidate_location_in") throw new Error("task_graph_current_location_evidence_unavailable")
  const criterion = { id: requirement.id, check: { kind: requirement.kind, locations: requirement.locations } } as const
  return nodes.flatMap(node => {
    if (evidence.excludedHistoricalNodeKeys.has(node.key)) return []
    if (!evidence.compatibleRetainedNodeKeys.has(node.key)) return [node]
    if (node.verification?.role !== "scout") throw new Error("task_graph_current_location_evidence_unavailable")
    const criteria = [...node.verification.criteria.filter(item => item.id !== requirement.id), criterion]
    return [{ ...node, verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout", criteria } }]
  })
}

function assertNoExcludedScoutDependencies(
  nodes: readonly TaskGraphObjectiveLineageNode[], proposedKeys: readonly string[], excluded: ReadonlySet<string>,
): void {
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const reachesExcluded = (key: string, seen: ReadonlySet<string>): boolean => {
    if (excluded.has(key)) return true
    if (seen.has(key)) return false
    const node = byKey.get(key)
    if (!node) return false
    const next = new Set(seen).add(key)
    return node.dependsOn.some(dependency => reachesExcluded(dependency, next))
  }
  if (proposedKeys.some(key => reachesExcluded(key, new Set()))) {
    throw Object.assign(new Error("TaskGraph plan depends on an excluded historical Scout"), { code: "task_graph_dependency_unverified" })
  }
}

function unavailable(code: string): never {
  throw Object.assign(new Error("Confirmed current-location evidence is unavailable"), { code })
}
