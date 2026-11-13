import { describe, expect, it } from "vitest"

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
    const duplicateWait = { messages: [
      waitRequest.messages[0], { role: "assistant", content: [{ type: "tool_use", id: "second-wait", name: "wait_subagents", input }] },
    ] }
    expect(() => find.findUniqueWaitInput(duplicateWait, ["child-a", "child-b"]))
      .toThrow("p1143_fixture_tool_pair_call_ambiguous")
  })
})
