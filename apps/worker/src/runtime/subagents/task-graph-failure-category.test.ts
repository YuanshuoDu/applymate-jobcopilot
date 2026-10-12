import { describe, expect, it } from "vitest"

import { classifyCurrentTaskGraphExecutionFailure } from "./task-graph-failure-category.js"

const eligible = { hasVerifiedReport: false, isNative: false } as const

describe("current TaskGraph execution failure categories", () => {
  it("maps only the nine exact ordinary-child literals into three coarse categories", () => {
    const setup = [
      "child_turn_missing",
      "subagent_role_unknown",
      "selected_job_context_unavailable",
      "writer_dependency_unavailable",
      "selected_job_sources_unavailable",
      "selected_job_output_contract_unavailable",
    ]
    for (const failureReason of setup) {
      expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason }, eligible))
        .toBe("execution_setup_unavailable")
    }
    for (const failureReason of ["child_resume_evidence_unavailable", "child_resume_unavailable"]) {
      expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason }, eligible))
        .toBe("resume_state_unavailable")
    }
    expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason: "invalid_structured_result" }, eligible))
      .toBe("structured_output_invalid")
  })

  it("omits categories for free text, near matches, other statuses and verifier/native cases", () => {
    for (const failureReason of [
      "provider_timeout", "Task setup unavailable", " selected_job_context_unavailable", "selected_job_context_unavailable:private",
      "native_verification_packet_invalid", "task_graph_verification_failed", "",
    ]) {
      expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason }, eligible)).toBeUndefined()
    }
    for (const status of ["completed", "retrying", "cancelled", "interrupted", "waiting", "running"]) {
      expect(classifyCurrentTaskGraphExecutionFailure({ status, failureReason: "invalid_structured_result" }, eligible)).toBeUndefined()
    }
    expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason: "invalid_structured_result" }, { ...eligible, hasVerifiedReport: true })).toBeUndefined()
    expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason: "invalid_structured_result" }, { ...eligible, isNative: true })).toBeUndefined()
  })

  it("requires own plain data status/reason and boolean eligibility without invoking getters", () => {
    const inherited = Object.create({ status: "failed", failureReason: "invalid_structured_result" }) as object
    expect(classifyCurrentTaskGraphExecutionFailure(inherited, eligible)).toBeUndefined()

    let getterCalls = 0
    const accessor = Object.defineProperties({}, {
      status: { get() { getterCalls += 1; return "failed" } },
      failureReason: { value: "invalid_structured_result" },
    })
    expect(classifyCurrentTaskGraphExecutionFailure(accessor, eligible)).toBeUndefined()
    expect(getterCalls).toBe(0)
    const reasonAccessor = Object.defineProperties({}, {
      status: { value: "failed" },
      failureReason: { get() { getterCalls += 1; return "invalid_structured_result" } },
    })
    expect(classifyCurrentTaskGraphExecutionFailure(reasonAccessor, eligible)).toBeUndefined()
    expect(getterCalls).toBe(0)
    const hiddenReason = Object.defineProperties({}, {
      status: { value: "failed", enumerable: true },
      failureReason: { value: "invalid_structured_result", enumerable: false },
    })
    expect(classifyCurrentTaskGraphExecutionFailure(hiddenReason, eligible)).toBeUndefined()
    const hiddenEligibility = Object.defineProperties({}, {
      hasVerifiedReport: { value: false, enumerable: false },
      isNative: { value: false, enumerable: true },
    }) as unknown as Parameters<typeof classifyCurrentTaskGraphExecutionFailure>[1]
    expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason: "invalid_structured_result" }, hiddenEligibility)).toBeUndefined()
    const malformedEligibility = { hasVerifiedReport: 0, isNative: false } as unknown as Parameters<typeof classifyCurrentTaskGraphExecutionFailure>[1]
    expect(classifyCurrentTaskGraphExecutionFailure({ status: "failed", failureReason: "invalid_structured_result" }, malformedEligibility)).toBeUndefined()
  })

  it("ignores a caller-supplied category and never returns raw reason data", () => {
    const projected = classifyCurrentTaskGraphExecutionFailure({
      status: "failed", failureReason: "invalid_structured_result", executionFailureCategory: "forged-private-value",
    }, eligible)
    expect(projected).toBe("structured_output_invalid")
    expect(projected).not.toBe("invalid_structured_result")
    expect(JSON.stringify(projected)).not.toContain("forged-private-value")
  })
})
