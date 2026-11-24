import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import {
  appendObjectiveTailorTaskGraphProposal,
  appendTaskGraphProposal,
  validateTaskGraphProposal,
  type TaskGraphNode,
  type TaskGraphNodeProposal,
  type TaskGraphState,
  type TaskGraphValidationOptions,
} from "./task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./task-graph-verification.js"

type Slot = {
  slotId: string
  sourceAnalystNodeKey: string
  writerNodeKey: string
  reviewerNodeKey: string
  correction?: { writerNodeKey: string; reviewerNodeKey: string }
}
const options: TaskGraphValidationOptions = {
  registeredTemplateIds: new Set(["scout", "analyst", "cover_letter_writer", "cover_letter_reviewer"]),
  maxNodes: 8,
  maxDepth: 8,
}

function sourceState(count = 7): TaskGraphState {
  const scoutCount = Math.min(3, Math.max(1, count - 1))
  const scouts = Array.from({ length: scoutCount }, (_, index) => sourceNode(`scout-${index + 1}`, "scout", [], index + 1))
  const analysts = Array.from({ length: count - scouts.length }, (_, index) => sourceNode(`analyst-${index + 1}`, "analyst",
    [`scout-${(index % scouts.length) + 1}`], scouts.length + index + 1))
  return { revision: count, nodes: [...scouts, ...analysts], appliedEvents: [] }
}

function sourceNode(key: string, role: "scout" | "analyst", dependsOn: string[], depth: number): TaskGraphNode {
  const check = role === "scout" ? { kind: "candidate_count_gte" as const, minimum: 1 } : { kind: "finding_count_gte" as const, minimum: 1 }
  return {
    key, templateId: role, goal: `Verify ${key}`, successCriteria: [`Verify ${key}`], dependsOn, depth, taskId: `task-${key}`,
    status: "completed", verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
      criteria: [{ id: "minimum-results", check }] },
  }
}

function newSlots(start: number, count: number): Slot[] {
  return Array.from({ length: count }, (_, index) => {
    const slot = start + index
    return { slotId: `tailor-${slot}`, sourceAnalystNodeKey: `analyst-${((slot - 1) % 4) + 1}`,
      writerNodeKey: `writer-${slot}`, reviewerNodeKey: `reviewer-${slot}` }
  })
}

function marker(sourceNodeCount: number, slots: readonly Slot[]): unknown {
  return { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount, slots }
}

function initialPairs(slots: readonly Slot[]): TaskGraphNodeProposal[] {
  const writers = slots.map(slot => ({ key: slot.writerNodeKey, templateId: "cover_letter_writer",
    goal: `Draft ${slot.slotId}`, successCriteria: [`Draft ${slot.slotId}`], dependsOn: [slot.sourceAnalystNodeKey] }))
  const reviewers = slots.map(slot => ({ key: slot.reviewerNodeKey, templateId: "cover_letter_reviewer",
    goal: `Review ${slot.slotId}`, successCriteria: [`Review ${slot.slotId}`], dependsOn: [slot.writerNodeKey] }))
  return [...writers, ...reviewers]
}

function correctionPairs(slots: readonly Slot[]): TaskGraphNodeProposal[] {
  const writers = slots.map(slot => ({ key: slot.correction!.writerNodeKey, templateId: "cover_letter_writer",
    goal: `Correct ${slot.slotId}`, successCriteria: [`Correct ${slot.slotId}`], dependsOn: [slot.reviewerNodeKey] }))
  const reviewers = slots.map(slot => ({ key: slot.correction!.reviewerNodeKey, templateId: "cover_letter_reviewer",
    goal: `Re-review ${slot.slotId}`, successCriteria: [`Re-review ${slot.slotId}`], dependsOn: [slot.correction!.writerNodeKey] }))
  return [...writers, ...reviewers]
}

function append(state: TaskGraphState, nodes: readonly TaskGraphNodeProposal[], slots: readonly Slot[]) {
  return appendObjectiveTailorTaskGraphProposal(state, { expectedRevision: state.revision, nodes }, options,
    marker(state.objectiveTailor?.sourceNodeCount ?? state.nodes.length, slots))
}

function accepted(state: TaskGraphState, nodes: readonly TaskGraphNodeProposal[], slots: readonly Slot[]): TaskGraphState {
  const result = append(state, nodes, slots)
  if (!result.ok) throw new Error(`append_failed:${result.error.code}`)
  return result.state
}

function complete(state: TaskGraphState, keys: ReadonlySet<string>): TaskGraphState {
  return { ...state, revision: state.revision + keys.size,
    nodes: state.nodes.map(node => keys.has(node.key) ? { ...node, status: "completed" as const } : node) }
}

function latestKeys(slots: readonly Slot[], corrections = false): Set<string> {
  return new Set(slots.flatMap(slot => corrections
    ? [slot.correction!.writerNodeKey, slot.correction!.reviewerNodeKey]
    : [slot.writerNodeKey, slot.reviewerNodeKey]))
}

function graphSlots(state: TaskGraphState): Slot[] {
  return state.objectiveTailor?.slots as Slot[] ?? []
}

describe("Objective Tailor TaskGraph append", () => {
  it("retains seven source nodes across two four-pair waves and two exact correction pairs", () => {
    expect(options.maxNodes).toBe(8)
    let state = sourceState()
    const first = newSlots(1, 4)
    state = accepted(state, initialPairs(first), first)
    expect(state.nodes).toHaveLength(15)
    expect(graphSlots(state)).toHaveLength(4)
    state = complete(state, latestKeys(first))

    const allSlots = [...graphSlots(state), ...newSlots(5, 4)]
    const second = allSlots.slice(4)
    state = accepted(state, initialPairs(second), allSlots)
    expect(state.nodes).toHaveLength(23)
    expect(graphSlots(state)).toHaveLength(8)
    state = complete(state, latestKeys(second))

    const corrected = graphSlots(state).map((slot, index) => index === 1 || index === 6
      ? { ...slot, correction: { writerNodeKey: `correction-writer-${index + 1}`, reviewerNodeKey: `correction-reviewer-${index + 1}` } }
      : slot)
    const corrections = corrected.filter(slot => slot.correction)
    state = accepted(state, correctionPairs(corrections), corrected)
    expect(state.nodes).toHaveLength(27)
    expect(state.objectiveTailor?.slots).toHaveLength(8)
    expect(state.objectiveTailor?.slots.filter(slot => slot.correction)).toHaveLength(2)
    expect(state.revision).toBeGreaterThan(7)
  })

  it("rejects generic planning on a marked graph even below the ordinary eight-node cap", () => {
    const state = accepted(sourceState(2), initialPairs(newSlots(1, 1)), newSlots(1, 1))
    expect(state.nodes).toHaveLength(4)
    const later: TaskGraphNodeProposal = { key: "writer-later", templateId: "cover_letter_writer", goal: "Draft",
      successCriteria: ["Draft"], dependsOn: ["analyst-1"] }
    const proposal = { expectedRevision: state.revision, nodes: [later] }
    expect(validateTaskGraphProposal(proposal, state, options)).toMatchObject({ ok: false, error: { code: "invalid_state" } })
    expect(appendTaskGraphProposal(state, proposal, options)).toMatchObject({ ok: false, error: { code: "invalid_state" } })
  })

  it("preserves revision fencing and refuses a mismatched first source boundary", () => {
    const state = sourceState()
    const slots = newSlots(1, 4)
    const stale = appendObjectiveTailorTaskGraphProposal(state,
      { expectedRevision: state.revision - 1, nodes: initialPairs(slots) }, options, marker(7, slots))
    expect(stale).toMatchObject({ ok: false, error: { code: "revision_mismatch" } })

    const wrongBoundary = appendObjectiveTailorTaskGraphProposal(state,
      { expectedRevision: state.revision, nodes: initialPairs(slots) }, options, marker(6, slots))
    expect(wrongBoundary).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })

  it("preserves every admitted slot and allows only correction pairs for old slots", () => {
    let state = sourceState()
    const first = newSlots(1, 4)
    state = accepted(state, initialPairs(first), first)
    const changed = graphSlots(state).map((slot, index) => index === 0
      ? { ...slot, sourceAnalystNodeKey: "analyst-2" } : slot)
    const reassigned = append(state, initialPairs(newSlots(5, 1)), [...changed, ...newSlots(5, 1)])
    expect(reassigned).toMatchObject({ ok: false, error: { code: "invalid_shape" } })

    const immatureSlot = { ...graphSlots(state)[0]!, correction: {
      writerNodeKey: "correction-writer-1", reviewerNodeKey: "correction-reviewer-1",
    } }
    const immatureCorrection = append(state, correctionPairs([immatureSlot]),
      graphSlots(state).map(slot => slot.slotId === immatureSlot.slotId ? immatureSlot : slot))
    expect(immatureCorrection).toMatchObject({ ok: false, error: { code: "invalid_shape" } })

    const newSlotWithCorrection = { ...newSlots(5, 1)[0]!, correction: {
      writerNodeKey: "correction-writer-5", reviewerNodeKey: "correction-reviewer-5",
    } }
    const immediateCorrection = append(state, [...initialPairs([newSlotWithCorrection]), ...correctionPairs([newSlotWithCorrection])],
      [...graphSlots(state), newSlotWithCorrection])
    expect(immediateCorrection).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })

  it("enforces four-pair append waves, the 40-node ceiling, and one correction per slot", () => {
    let state = sourceState(8)
    let slots: Slot[] = []
    for (const start of [1, 5]) {
      const wave = newSlots(start, 4)
      slots = [...slots, ...wave]
      state = accepted(state, initialPairs(wave), slots)
      state = complete(state, latestKeys(wave))
    }
    for (const start of [1, 5]) {
      const correctionSlots = slots.slice(start - 1, start + 3).map(slot => ({ ...slot, correction: {
        writerNodeKey: `correction-writer-${slot.slotId}`, reviewerNodeKey: `correction-reviewer-${slot.slotId}`,
      } }))
      slots = slots.map(slot => correctionSlots.find(item => item.slotId === slot.slotId) ?? slot)
      state = accepted(state, correctionPairs(correctionSlots), slots)
      state = complete(state, latestKeys(correctionSlots, true))
    }
    expect(state.nodes).toHaveLength(40)
    const extra = appendObjectiveTailorTaskGraphProposal(state,
      { expectedRevision: state.revision, nodes: [{ key: "overflow", templateId: "cover_letter_writer", goal: "Overflow",
        successCriteria: ["Overflow"], dependsOn: ["analyst-1"] }] }, options, state.objectiveTailor)
    expect(extra).toMatchObject({ ok: false, error: { code: "node_limit" } })

    const small = sourceState()
    const five = newSlots(1, 5)
    expect(append(small, initialPairs(five), five)).toMatchObject({ ok: false, error: { code: "node_limit" } })
  })
})
