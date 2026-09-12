import { describe, expect, it } from "vitest"

import type { StepContextSnapshot } from "../context/step-context-builder.js"
import {
  PLAN_COMPLETION_BLOCKER,
  PLAN_COMPLETION_FEEDBACK,
  verifyPlanCompletion,
} from "./plan-completion-verifier.js"

function snapshot(toolObservations: StepContextSnapshot["toolObservations"]): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations }
}

function result(callId: string, localId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `plan-result:${callId}:${localId}`,
    content: {
      kind: "plan_command", localId, commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { safe: true },
      ...overrides,
    },
  }
}

function completion(callId: string, localId = "finish", dependsOn: readonly string[] = ["read"], overrides: Record<string, unknown> = {}) {
  return {
    id: `plan-control:${callId}:${localId}`,
    content: { kind: "plan_control", localId, status: "completion_proposed", dependsOn, completionCriteria: ["finish"], ...overrides },
  }
}

describe("verifyPlanCompletion", () => {
  it("preserves compatibility when the server-owned requirement is disabled", () => {
    expect(verifyPlanCompletion({ snapshot: snapshot([]) })).toEqual({ ok: true })
    expect(verifyPlanCompletion({ toolObservations: [], required: false })).toEqual({ ok: true })
  })

  it("accepts a latest completion proposal and only its same-plan successful dependencies", () => {
    const callId = "plan:call:1"
    expect(verifyPlanCompletion({
      snapshot: snapshot([
        result("old", "read"), completion("old"),
        result(callId, "read"), completion(callId),
      ]), required: true,
    })).toEqual({ ok: true })
  })

  it.each([
    { label: "missing completion control", observations: [result("plan:1", "read")] },
    { label: "missing dependency", observations: [completion("plan:1")] },
    { label: "failed dependency", observations: [result("plan:1", "read", { status: "failed", errorCode: "denied" }), completion("plan:1")] },
    { label: "dependency after control", observations: [completion("plan:1"), result("plan:1", "read")] },
    { label: "duplicate dependency declaration", observations: [result("plan:1", "read"), completion("plan:1", "finish", ["read", "read"]) ] },
    { label: "duplicate completion control", observations: [result("plan:1", "read"), completion("plan:1"), completion("plan:1")] },
    { label: "malformed criteria", observations: [result("plan:1", "read"), completion("plan:1", "finish", ["read"], { completionCriteria: "finish" })] },
  ])("fails closed for $label", ({ observations }) => {
    const resultValue = verifyPlanCompletion({ snapshot: snapshot(observations), required: true })
    expect(resultValue).toEqual({ ok: false, blocker: PLAN_COMPLETION_BLOCKER, feedback: PLAN_COMPLETION_FEEDBACK })
  })

  it("rejects a dependency observation from another plan even when its local id matches", () => {
    const observations = [result("other", "read"), completion("plan:1")]
    const resultValue = verifyPlanCompletion({ snapshot: snapshot(observations), required: true })
    expect(resultValue.ok).toBe(false)
    expect(JSON.stringify(resultValue)).not.toContain("other")
  })

  it("does not include untrusted observation content in fixed failure feedback", () => {
    const secret = "sensitive-model-content"
    const resultValue = verifyPlanCompletion({
      snapshot: snapshot([result("plan:1", "read", { status: "failed", errorCode: secret }), completion("plan:1")]), required: true,
    })
    expect(resultValue).toEqual({ ok: false, blocker: PLAN_COMPLETION_BLOCKER, feedback: PLAN_COMPLETION_FEEDBACK })
    expect(JSON.stringify(resultValue)).not.toContain(secret)
  })
})
