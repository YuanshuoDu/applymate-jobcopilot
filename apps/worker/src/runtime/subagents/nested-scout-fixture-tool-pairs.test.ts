import { describe, expect, it } from "vitest"
// @ts-expect-error Fixture-only JavaScript module has no declaration; Vitest resolves the import at runtime.
import { classifyWaitTaskAliases, compareWaitTaskIds, isSafeParentResumeDiagnostic, parentResumeFixtureErrorClass } from "./nested-scout-delegation-worker-fixture-scripts.mjs"

type ToolPair = Readonly<{ callId: string; output: unknown; isError: boolean }>
type PairApi = Readonly<{
  findExactToolResult: (request: unknown, expected: Readonly<{ name: string; input: unknown }>) => ToolPair | null
  findUniqueWaitInput: (request: unknown, taskIds: readonly string[]) => unknown | null
}>
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function resolver(): Promise<PairApi> {
  const loaded: unknown = await import(new URL("./nested-scout-fixture-tool-pairs.mjs", import.meta.url).href)
  const module = record(loaded), exact = module?.findExactToolResult, wait = module?.findUniqueWaitInput
  if (typeof exact !== "function" || typeof wait !== "function") throw new Error("fixture tool pair resolver is unavailable")
  return { findExactToolResult: exact as PairApi["findExactToolResult"], findUniqueWaitInput: wait as PairApi["findUniqueWaitInput"] }
}

function request(input: unknown, options: { id?: string; result?: string; isError?: unknown; copies?: number } = {}) {
  const id = options.id ?? "projected-toolcall-alias"
  const use = { type: "tool_use", id, name: "jobs.discover", input }
  const result = { type: "tool_result", toolUseId: id, content: options.result ?? JSON.stringify({ jobs: [{ id: "job-1" }] }),
    ...(options.isError === undefined ? {} : { isError: options.isError }) }
  return { messages: [
    { role: "assistant", content: Array.from({ length: options.copies ?? 1 }, () => use) },
    { role: "tool", content: [result] },
  ] }
}

describe("nested Scout fixture tool/result pairing", () => {
  it("matches the projected tool-use id by exact name and input, not a raw call id", async () => {
    const find = await resolver()
    const input = { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], source: "greenhouse", pageSize: 10 }
    const result = find.findExactToolResult(request(input), { name: "jobs.discover", input })
    expect(result).toEqual({ callId: "projected-toolcall-alias", output: { jobs: [{ id: "job-1" }] }, isError: false })
  })

  it("requires exact input and returns no match for a different action payload", async () => {
    const find = await resolver()
    const observedInput = { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], source: "greenhouse", pageSize: 10 }
    expect(find.findExactToolResult(request(observedInput), { name: "jobs.discover", input: { ...observedInput, source: "lever" } })).toBeNull()
    expect(find.findExactToolResult(request(observedInput), { name: "scout.delegate", input: observedInput })).toBeNull()
  })

  it("fails closed when an exact tool use or its paired result is ambiguous", async () => {
    const find = await resolver()
    const input = { goal: "Read assigned role", sourceSlice: ["greenhouse"] }
    const duplicateCall = { messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: "alias-a", name: "scout.delegate", input },
        { type: "tool_use", id: "alias-b", name: "scout.delegate", input },
      ] },
    ] }
    expect(() => find.findExactToolResult(duplicateCall, { name: "scout.delegate", input })).toThrow("p1143_fixture_tool_pair_call_ambiguous")

    const duplicateResult = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "alias-a", name: "scout.delegate", input }] },
      { role: "tool", content: [
        { type: "tool_result", toolUseId: "alias-a", content: "{}" },
        { type: "tool_result", toolUseId: "alias-a", content: "{}" },
      ] },
    ] }
    expect(() => find.findExactToolResult(duplicateResult, { name: "scout.delegate", input })).toThrow("p1143_fixture_tool_pair_result_ambiguous")
  })

  it("preserves the result error flag and rejects malformed result payloads", async () => {
    const find = await resolver()
    const input = { goal: "Try out-of-scope source", sourceSlice: ["lever"] }
    expect(find.findExactToolResult(request(input, { isError: true }), { name: "jobs.discover", input })?.isError).toBe(true)
    expect(() => find.findExactToolResult(request(input, { isError: "true" }), { name: "jobs.discover", input }))
      .toThrow("p1143_fixture_tool_pair_result_invalid")
    expect(() => find.findExactToolResult(request(input, { result: "not-json" }), { name: "jobs.discover", input }))
      .toThrow("p1143_fixture_tool_pair_result_invalid")
  })

  it("matches a wait result only with the exact expected targets and options", async () => {
    const find = await resolver()
    const input = { idempotencyKey: `final-dependency-wait:${"a".repeat(64)}`, taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 30_000 }
    const waitRequest = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "projected-wait-alias", name: "wait_subagents", input }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "projected-wait-alias", content: JSON.stringify({ status: "ready" }) }] },
    ] }
    expect(find.findUniqueWaitInput(waitRequest, ["child-a", "child-b"])).toEqual(input)
    const resolvedWaitInput = find.findUniqueWaitInput(waitRequest, ["child-a", "child-b"])
    expect(find.findExactToolResult(waitRequest, { name: "wait_subagents", input: resolvedWaitInput })?.output).toEqual({ status: "ready" })
    expect(() => find.findUniqueWaitInput(waitRequest, ["child-a"]))
      .toThrow("p1143_fixture_wait_input_invalid")
  })

  it("selects the last persisted wait and pairs its result by that call ID when inputs repeat", async () => {
    const find = await resolver()
    const input = { idempotencyKey: `final-dependency-wait:${"a".repeat(64)}`, taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 30_000 }
    const history = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "older-wait", name: "wait_subagents", input }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "older-wait", content: JSON.stringify({ status: "waiting", turn: 1 }) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "latest-wait", name: "wait_subagents", input }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "latest-wait", content: JSON.stringify({ status: "ready", turn: 2 }) }] },
    ] }

    expect(find.findUniqueWaitInput(history, ["child-a", "child-b"])).toBe(input)
    expect(find.findExactToolResult(history, { name: "wait_subagents", input }))
      .toEqual({ callId: "latest-wait", output: { status: "ready", turn: 2 }, isError: false })
  })

  it("selects and validates the last wait input without falling back to an earlier valid wait", async () => {
    const find = await resolver()
    const valid = { idempotencyKey: `final-dependency-wait:${"a".repeat(64)}`, taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 30_000 }
    const invalidLatest = { ...valid, timeoutMs: 29_999 }
    const history = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "older-wait", name: "wait_subagents", input: valid }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "older-wait", content: "{}" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "latest-wait", name: "wait_subagents", input: invalidLatest }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "latest-wait", content: "{}" }] },
    ] }

    expect(() => find.findUniqueWaitInput(history, ["child-a", "child-b"]))
      .toThrow("p1143_fixture_wait_input_invalid")
  })

  it("rejects a missing or duplicate result for the latest wait instead of reusing an older result", async () => {
    const find = await resolver()
    const input = { idempotencyKey: `final-dependency-wait:${"a".repeat(64)}`, taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 30_000 }
    const missingLatest = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "older-wait", name: "wait_subagents", input }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "older-wait", content: JSON.stringify({ status: "ready" }) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "latest-wait", name: "wait_subagents", input }] },
    ] }
    const duplicateLatest = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "latest-wait", name: "wait_subagents", input }] },
      { role: "tool", content: [
        { type: "tool_result", toolUseId: "latest-wait", content: JSON.stringify({ status: "ready" }) },
        { type: "tool_result", toolUseId: "latest-wait", content: JSON.stringify({ status: "timed_out" }) },
      ] },
    ] }

    const latestInput = find.findUniqueWaitInput(missingLatest, ["child-a", "child-b"])
    expect(() => find.findExactToolResult(missingLatest, { name: "wait_subagents", input: latestInput }))
      .toThrow("p1143_fixture_tool_pair_result_invalid")
    expect(() => find.findExactToolResult(duplicateLatest, { name: "wait_subagents", input }))
      .toThrow("p1143_fixture_tool_pair_result_ambiguous")
  })
})

describe("nested Scout parent resume diagnostics", () => {
  it("maps only fixed fixture sentinels and preserves safe code precedence", () => {
    expect(parentResumeFixtureErrorClass(new Error("p1143_parent_job_read_failed"))).toBe("parent_job_read_failed")
    expect(parentResumeFixtureErrorClass(new Error("p1143_parent_current_reads_missing"))).toBe("parent_current_reads_missing")
    expect(parentResumeFixtureErrorClass(new Error("p1143_fixture_tool_pair_request_invalid"))).toBe("tool_pair_request_invalid")
    expect(parentResumeFixtureErrorClass(new Error("p1143_fixture_tool_pair_call_invalid"))).toBe("tool_pair_call_invalid")
    expect(parentResumeFixtureErrorClass(new Error("p1143_fixture_wait_input_invalid"))).toBe("wait_input_invalid")
    expect(parentResumeFixtureErrorClass(Object.assign(new Error("p1143_parent_job_read_failed"), { code: "turn_execution_failed" })))
      .toBe("turn_execution_failed")
    expect(parentResumeFixtureErrorClass(new Error("private failure details"))).toBe("error")
  })

  it("accepts only safe parent resume diagnostic classes", () => {
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:parent_job_reads:parent_job_read_failed")).toBe(true)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:parent_job_reads:parent_current_reads_missing")).toBe(true)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:tool_pair_request_invalid")).toBe(true)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:tool_pair_call_invalid")).toBe(true)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:wait_input_invalid")).toBe(true)
  })

  it("rejects unknown classes and raw fixture sentinels", () => {
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:parent_job_reads:other_error")).toBe(false)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:parent_job_reads:p1143_parent_job_read_failed")).toBe(false)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:parent_job_reads:p1143_parent_current_reads_missing")).toBe(false)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:p1143_fixture_tool_pair_request_invalid")).toBe(false)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:p1143_fixture_tool_pair_call_invalid")).toBe(false)
    expect(isSafeParentResumeDiagnostic("P1143_PARENT_RESUME_ERROR:wait_input_parse:p1143_fixture_wait_input_invalid")).toBe(false)
  })
})

describe("nested Scout wait task ID diagnostic", () => {
  it("distinguishes ordered, reordered, and different bounded task ID sets without returning IDs", () => {
    const expectedByAlias = { alpha: "task-a", beta: "task-b" }
    expect(compareWaitTaskIds(["task-a", "task-b"], ["task-a", "task-b"], expectedByAlias))
      .toEqual({ orderedMatch: true, setMatches: true, containsExpectedAlpha: true, containsExpectedBeta: true })
    expect(compareWaitTaskIds(["task-a", "task-b"], ["task-b", "task-a"], expectedByAlias))
      .toEqual({ orderedMatch: false, setMatches: true, containsExpectedAlpha: true, containsExpectedBeta: true })
    expect(compareWaitTaskIds(["task-a", "task-b"], ["task-a", "task-c"], expectedByAlias))
      .toEqual({ orderedMatch: false, setMatches: false, containsExpectedAlpha: true, containsExpectedBeta: false })
  })

  it("fails closed for duplicate, non-string, oversized, or overlong diagnostic inputs", () => {
    expect(compareWaitTaskIds(["task-a", "task-b"], ["task-a", "task-a"]))
      .toEqual({ orderedMatch: false, setMatches: false, containsExpectedAlpha: false, containsExpectedBeta: false })
    expect(compareWaitTaskIds(["task-a", "task-b"], ["task-a", 2]))
      .toEqual({ orderedMatch: false, setMatches: false, containsExpectedAlpha: false, containsExpectedBeta: false })
    expect(compareWaitTaskIds(Array.from({ length: 9 }, (_, index) => `task-${index}`), Array.from({ length: 9 }, (_, index) => `task-${index}`)))
      .toEqual({ orderedMatch: false, setMatches: false, containsExpectedAlpha: false, containsExpectedBeta: false })
    expect(compareWaitTaskIds(["task-a"], ["x".repeat(257)]))
      .toEqual({ orderedMatch: false, setMatches: false, containsExpectedAlpha: false, containsExpectedBeta: false })
  })

  it("maps expected receipts and observed targets to only fixed current-child aliases", () => {
    expect(classifyWaitTaskAliases({ alpha: "task-a", beta: "task-b" }, ["task-b", "task-a"], [
      { taskId: "task-a", alias: "alpha" }, { taskId: "task-b", alias: "beta" },
    ])).toEqual({ available: true, expectedAlphaCurrentChildAlias: "alpha", expectedBetaCurrentChildAlias: "beta",
      observedContainsExpectedAlpha: true, observedContainsExpectedBeta: true, observedTargetAliases: ["beta", "alpha"],
      observedTargetsContainCurrentAlpha: true, observedTargetsContainCurrentBeta: true, unmatchedObservedCount: "zero" })
  })

  it("distinguishes old delegate receipts from current observed child aliases without exposing identifiers", () => {
    expect(classifyWaitTaskAliases({ alpha: "old-alpha", beta: "old-beta" }, ["current-alpha", "current-beta"], [
      { taskId: "current-alpha", alias: "alpha" }, { taskId: "current-beta", alias: "beta" },
    ])).toEqual({ available: true, expectedAlphaCurrentChildAlias: "unmatched", expectedBetaCurrentChildAlias: "unmatched",
      observedContainsExpectedAlpha: false, observedContainsExpectedBeta: false, observedTargetAliases: ["alpha", "beta"],
      observedTargetsContainCurrentAlpha: true, observedTargetsContainCurrentBeta: true, unmatchedObservedCount: "zero" })

    expect(classifyWaitTaskAliases({ alpha: "task-a", beta: "task-b" }, ["foreign-a", "foreign-b"], [
      { taskId: "task-a", alias: "alpha" }, { taskId: "task-b", alias: "beta" },
    ])).toMatchObject({ observedTargetAliases: ["unmatched", "unmatched"], unmatchedObservedCount: "two",
      expectedAlphaCurrentChildAlias: "alpha", expectedBetaCurrentChildAlias: "beta" })
  })
})
