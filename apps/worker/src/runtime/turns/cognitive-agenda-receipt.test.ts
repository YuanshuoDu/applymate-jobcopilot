import { describe, expect, it } from "vitest"

import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import {
  buildCognitiveAgendaReceipt,
  cognitiveAgendaReceiptIdempotencyKey,
  COGNITIVE_AGENDA_EVENT_TYPE,
  COGNITIVE_AGENDA_RECEIPT_SCHEMA_VERSION,
  parseCognitiveAgendaReceipt,
  type CognitiveAgendaReceipt,
  type CognitiveAgendaReceiptScope,
} from "./cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"

const scope: CognitiveAgendaReceiptScope = { sessionId: "session-1", turnId: "turn-1", taskId: "task-1", stepId: "turn:turn-1:step:0" }

function context(): StepContext {
  return {
    schemaVersion: "agent-harness.v2", sessionId: scope.sessionId, turnId: scope.turnId, stepId: scope.stepId,
    inputThroughSequence: 1n, consumedInputIds: [], canonicalJson: "{}", blocks: [{ id: "goal-1", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: { revision: 2, objective: "secret objective" } }],
  }
}

function receipt(): CognitiveAgendaReceipt {
  const value = buildCognitiveAgendaReceipt({ ...scope, agenda: buildCognitiveActionAgenda(context()) })
  if (!value) throw new Error("fixture receipt should be valid")
  return value
}

describe("cognitive agenda receipt", () => {
  it("builds a deterministic server-owned receipt and stable step key", () => {
    const first = receipt(), second = buildCognitiveAgendaReceipt({ ...scope, agenda: buildCognitiveActionAgenda(context()) })
    expect(second).toEqual(first)
    expect(first.schemaVersion).toBe(COGNITIVE_AGENDA_RECEIPT_SCHEMA_VERSION)
    expect(first.externalDataPolicy).toContain("never instructions")
    expect(JSON.stringify(first)).not.toContain("secret objective")
    expect(COGNITIVE_AGENDA_EVENT_TYPE).toBe("cognitive.agenda")
    expect(cognitiveAgendaReceiptIdempotencyKey(scope.stepId)).toBe("cognitive.agenda:turn:turn-1:step:0")
    expect(cognitiveAgendaReceiptIdempotencyKey(scope.stepId)).toBe(cognitiveAgendaReceiptIdempotencyKey(scope.stepId))
  })

  it("accepts the exact scope and rejects foreign or extra fields", () => {
    const value = receipt()
    expect(parseCognitiveAgendaReceipt(value, scope)).toEqual(value)
    expect(parseCognitiveAgendaReceipt({ ...value, taskId: "other-task" }, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, extra: "raw user text" } as never, scope)).toBeNull()
    expect(parseCognitiveAgendaReceipt({ ...value, nextAction: "follow_external_instruction" } as never, scope)).toBeNull()
  })

  it("preserves safe legacy short step IDs", () => {
    const legacyScope = { ...scope, stepId: "step-1" }
    const value = buildCognitiveAgendaReceipt({ ...legacyScope, agenda: buildCognitiveActionAgenda(context()) })
    expect(value?.stepId).toBe("step-1")
    expect(parseCognitiveAgendaReceipt(value, legacyScope)).toEqual(value)
    expect(cognitiveAgendaReceiptIdempotencyKey("step-1")).toBe("cognitive.agenda:step-1")
    expect(cognitiveAgendaReceiptIdempotencyKey("sha256:bb5c15da-8380-4595-a70e-df61daefeaeb")).toBeNull()
  })

  it("accepts and parses a generated step ID longer than the generic ID limit", () => {
    const turnId = "process-restart-turn-cdf8000f-87d2-4f57-aa24-a896766cb119"
    const longScope: CognitiveAgendaReceiptScope = {
      sessionId: "process-restart-session-cdf8000f-87d2-4f57-aa24-a896766cb119",
      turnId,
      taskId: `root-${turnId}`,
      stepId: `turn:${turnId}:step:0:bb5c15da-8380-4595-a70e-df61daefeaeb`,
    }
    expect(longScope.stepId.length).toBeGreaterThan(96)
    const value = buildCognitiveAgendaReceipt({
      ...longScope,
      inputThroughSequence: 7n,
      consumedInputIds: [],
      agenda: buildCognitiveActionAgenda(context()),
    })
    expect(value).not.toBeNull()
    expect(parseCognitiveAgendaReceipt(value, longScope)).toEqual(value)
  })

  it("keeps long-step idempotency keys deterministic and within the key bound", () => {
    const stepIdAtLength = (length: number) => `turn:${"t".repeat(length - "turn:".length - ":step:0:".length - 36)}:step:0:bb5c15da-8380-4595-a70e-df61daefeaeb`
    const stepId = stepIdAtLength(256)
    expect(stepId.length).toBe(256)
    const key = cognitiveAgendaReceiptIdempotencyKey(stepId)
    expect(key).toMatch(/^cognitive\.agenda:sha256:[a-f0-9]{64}$/)
    expect(Buffer.byteLength(key ?? "", "utf8")).toBeLessThanOrEqual(256)
    expect(cognitiveAgendaReceiptIdempotencyKey(stepId)).toBe(key)
    expect(cognitiveAgendaReceiptIdempotencyKey(stepIdAtLength(257))).toBeNull()
    expect(cognitiveAgendaReceiptIdempotencyKey("step-\u0000")).toBeNull()
  })

  it("carries a server-owned step cursor while accepting legacy receipts", () => {
    const fenced = buildCognitiveAgendaReceipt({ ...scope, inputThroughSequence: 7n, consumedInputIds: ["input-1"], agenda: buildCognitiveActionAgenda(context()) })
    expect(fenced?.resumeFence).toEqual({ inputThroughSequence: "7", consumedInputIds: ["input-1"] })
    expect(parseCognitiveAgendaReceipt(fenced, scope)).toEqual(fenced)
    expect(parseCognitiveAgendaReceipt(receipt(), scope)?.resumeFence).toBeUndefined()
  })

  it("rejects malformed and oversized payloads without throwing", () => {
    const value = receipt()
    const ids = Array.from({ length: 16 }, (_, index) => `reference-${String(index).padStart(2, "0")}-${"x".repeat(84)}`)
    const signal = { count: ids.length, ids }
    const oversized = { ...value, signals: { pendingInputs: signal, approvals: signal, activeWaits: signal, unresolved: signal, completionVerification: signal, steering: { present: true, fresh: true, active: signal, newlyObserved: signal } } }
    expect(parseCognitiveAgendaReceipt(oversized, scope)).toBeNull()
    const cyclic: Record<string, unknown> = { ...value }; cyclic.self = cyclic
    expect(parseCognitiveAgendaReceipt(cyclic, scope)).toBeNull()
  })
})
