import { describe, expect, it } from "vitest"
import { STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS } from "../subagents/steering-reconciliation-contract.js"
import {
  parseTurnQuestionPlanningReceipt,
  summarizeTurnQuestionPlanningReceipt,
  turnQuestionPlanningEventKey,
  TURN_QUESTION_PLANNING_EVENT_TYPE,
  TURN_QUESTION_PLANNING_SCHEMA_VERSION,
  type TurnQuestionPlanningReceipt,
} from "./turn-question-planning-contract.js"

const valid: TurnQuestionPlanningReceipt = {
  schemaVersion: TURN_QUESTION_PLANNING_SCHEMA_VERSION,
  sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", stepId: "step-4", toolCallId: "call-7",
  waitId: "a".repeat(64), questionItemId: `agent-wait:question:${"a".repeat(64)}`,
  observedPlanRevision: 2, graphRevisionAtAsk: 3,
  pendingSteers: [
    { id: "steer-1", acceptedSequence: "9", status: "consumed", consumedByStepId: "step-3", consumingOrdinal: 3 },
    { id: "steer-2", acceptedSequence: "12", status: "accepted", consumedByStepId: null, consumingOrdinal: null },
  ],
  inputCheckpoint: { throughSequence: "12", consumedInputIds: ["original-input", "steer-1"] },
}
function pendingSteerSet(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `steer-${index}`, acceptedSequence: String(index + 1),
    status: "accepted" as const, consumedByStepId: null, consumingOrdinal: null }))
}

describe("turn question planning clarification contract", () => {
  it("parses the private observation and projects only bounded safe counts and revisions", () => {
    const parsed = parseTurnQuestionPlanningReceipt(valid)
    expect(parsed).toEqual(valid)
    expect(summarizeTurnQuestionPlanningReceipt(parsed!)).toEqual({
      observedPlanRevision: 2, graphRevisionAtAsk: 3, pendingSteerCount: 2,
      unconsumedSteerCount: 1, inputThroughSequence: "12",
    })
    expect(Object.keys(summarizeTurnQuestionPlanningReceipt(parsed!)).sort()).toEqual([
      "graphRevisionAtAsk", "inputThroughSequence", "observedPlanRevision", "pendingSteerCount", "unconsumedSteerCount",
    ])
    expect(TURN_QUESTION_PLANNING_EVENT_TYPE).toBe("agent.plan.clarification")
    expect(turnQuestionPlanningEventKey("turn-1", valid.waitId)).toBe(`turn:turn-1:event:planning-clarification:${valid.waitId}`)
  })

  it("allows an empty graph and nullable agenda revision without fabricating pending rows", () => {
    const parsed = parseTurnQuestionPlanningReceipt({ ...valid, observedPlanRevision: null, graphRevisionAtAsk: 0,
      pendingSteers: [], inputCheckpoint: { throughSequence: "0", consumedInputIds: [] } })
    expect(parsed).toBeDefined()
    expect(summarizeTurnQuestionPlanningReceipt(parsed!)).toEqual({ observedPlanRevision: null, graphRevisionAtAsk: 0,
      pendingSteerCount: 0, unconsumedSteerCount: 0, inputThroughSequence: "0" })
  })

  it("accepts and preserves the ledger maximum pending steer set", () => {
    const pendingSteers = pendingSteerSet(STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS)
    const parsed = parseTurnQuestionPlanningReceipt({ ...valid, pendingSteers })
    expect(parsed).toEqual({ ...valid, pendingSteers })
    expect(summarizeTurnQuestionPlanningReceipt(parsed!).pendingSteerCount).toBe(STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS)
  })

  it("rejects pending steers beyond the ledger maximum", () => {
    expect(parseTurnQuestionPlanningReceipt({ ...valid,
      pendingSteers: pendingSteerSet(STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS + 1) })).toBeUndefined()
  })

  it.each([
    ["extra private text", { ...valid, question: "raw question" }],
    ["wrong schema", { ...valid, schemaVersion: "other" }],
    ["foreign question item", { ...valid, questionItemId: "other" }],
    ["duplicate steer ids", { ...valid, pendingSteers: [valid.pendingSteers[0], { ...valid.pendingSteers[1], id: "steer-1" }] }],
    ["duplicate input sequences", { ...valid, pendingSteers: [valid.pendingSteers[0], { ...valid.pendingSteers[1], acceptedSequence: "9" }] }],
    ["consumed row without consumer", { ...valid, pendingSteers: [{ ...valid.pendingSteers[0], consumedByStepId: null }] }],
    ["unconsumed row with consumer", { ...valid, pendingSteers: [{ ...valid.pendingSteers[1], consumedByStepId: "step-3", consumingOrdinal: 3 }] }],
    ["invalid graph revision", { ...valid, graphRevisionAtAsk: -1 }],
    ["invalid checkpoint sequence", { ...valid, inputCheckpoint: { ...valid.inputCheckpoint, throughSequence: "01" } }],
    ["duplicate checkpoint IDs", { ...valid, inputCheckpoint: { ...valid.inputCheckpoint, consumedInputIds: ["same", "same"] } }],
  ])("rejects %s", (_name, candidate) => {
    expect(parseTurnQuestionPlanningReceipt(candidate)).toBeUndefined()
  })
})
