import {
  OBJECTIVE_TAILOR_GRAPH_MAX_NODES,
  OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
  parseObjectiveTailorGraph,
  type ObjectiveTailorGraph,
} from "@jobcopilot/agent-protocol"
import type {
  TaskGraphAppendResult,
  TaskGraphNode,
  TaskGraphState,
  TaskGraphValidationOptions,
  TaskGraphValidationResult,
} from "./task-graph.js"
import { isTaskGraphTerminal } from "./task-graph-transition-rules.js"

type Validator = (value: unknown, state: TaskGraphState, options: TaskGraphValidationOptions,
  hardMaxNodes: number, maxAddedNodes: number) => TaskGraphValidationResult

/** Validates the marker transition around the same proposal kernel used by ordinary planning. */
export function appendObjectiveTailorTaskGraphProposalWithValidator(
  state: TaskGraphState, value: unknown, options: TaskGraphValidationOptions, nextMarker: unknown, validate: Validator,
): TaskGraphAppendResult {
  if (!state || typeof state !== "object" || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.nodes) || !Array.isArray(state.appliedEvents)) return failure("invalid_state", "state")
  const marker = Object.getOwnPropertyDescriptor(state, "objectiveTailor")
  if (marker && (!marker.enumerable || !("value" in marker))) return failure("invalid_state", "state.objectiveTailor")
  const current = marker ? parseObjectiveTailorGraph(marker.value, state.nodes) : null
  if (marker && !current) return failure("invalid_state", "state.objectiveTailor")
  const sourceCount = current?.sourceNodeCount ?? state.nodes.length
  if (!state.nodes.slice(0, sourceCount).every(node => isTaskGraphTerminal(node.status))) return failure("invalid_state", "state.sourcePrefix")
  const boundedOptions = { ...options, maxNodes: OBJECTIVE_TAILOR_GRAPH_MAX_NODES }
  const validation = validate(value, state, boundedOptions, OBJECTIVE_TAILOR_GRAPH_MAX_NODES, 8)
  if (!validation.ok) return validation
  const nodes = [...state.nodes, ...validation.addedNodes]
  const next = parseObjectiveTailorGraph(nextMarker, nodes)
  if (!next || !validTransition(current, next, state.nodes.length, state.nodes, validation.addedNodes)) {
    return failure("invalid_shape", "objectiveTailor")
  }
  return {
    ok: true,
    state: { ...state, revision: state.revision + 1, nodes, objectiveTailor: next },
    addedNodes: validation.addedNodes,
  }
}

function validTransition(
  previous: ObjectiveTailorGraph | null,
  next: ObjectiveTailorGraph,
  previousNodeCount: number,
  previousNodes: readonly TaskGraphNode[],
  addedNodes: readonly TaskGraphNode[],
): boolean {
  const introduced = new Set<string>(), priorByKey = new Map(previousNodes.map(node => [node.key, node] as const))
  const addPair = (writer: string, reviewer: string) => { introduced.add(writer); introduced.add(reviewer) }
  if (!previous) {
    if (next.sourceNodeCount !== previousNodeCount || next.slots.some(slot => slot.correction)) return false
    for (const slot of next.slots) addPair(slot.writerNodeKey, slot.reviewerNodeKey)
    return sameKeys(introduced, addedNodes)
  }
  if (next.sourceNodeCount !== previous.sourceNodeCount || next.slots.length < previous.slots.length) return false
  if (next.schemaVersion !== previous.schemaVersion || previous.schemaVersion === OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION
    && next.schemaVersion === OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION
    && next.reportScoreFloor !== previous.reportScoreFloor) return false
  for (let index = 0; index < previous.slots.length; index++) {
    const old = previous.slots[index]!, current = next.slots[index]!
    if (old.slotId !== current.slotId || old.sourceAnalystNodeKey !== current.sourceAnalystNodeKey
      || old.writerNodeKey !== current.writerNodeKey || old.reviewerNodeKey !== current.reviewerNodeKey) return false
    if (old.correction) {
      if (current.correction?.writerNodeKey !== old.correction.writerNodeKey
        || current.correction.reviewerNodeKey !== old.correction.reviewerNodeKey) return false
    } else if (current.correction) {
      if (priorByKey.get(old.reviewerNodeKey)?.status !== "completed") return false
      addPair(current.correction.writerNodeKey, current.correction.reviewerNodeKey)
    }
  }
  for (const slot of next.slots.slice(previous.slots.length)) {
    if (slot.correction) return false
    addPair(slot.writerNodeKey, slot.reviewerNodeKey)
  }
  return sameKeys(introduced, addedNodes)
}

function sameKeys(keys: ReadonlySet<string>, nodes: readonly TaskGraphNode[]): boolean {
  return keys.size === nodes.length && nodes.every(node => keys.has(node.key))
}

function failure(code: "invalid_state" | "invalid_shape", path: string): TaskGraphAppendResult {
  return { ok: false, error: { code, path, message: "Objective Tailor graph append is invalid" } }
}
