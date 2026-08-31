import { describe, expect, it, vi } from "vitest"

import { NextStepValidationError, parseNextStep, validateNextStep } from "./next-step.js"

const toolStep = {
  schemaVersion: "agent-harness.v2",
  kind: "call_tool",
  callId: "call-1",
  tool: "jobs.search",
  arguments: { query: "backend" },
  rationaleSummary: "Search the current user's scoped job index.",
} as const

describe("NextStep structured/text fallback", () => {
  it("accepts every planner intent from the technical contract", async () => {
    const intents = [
      toolStep,
      { schemaVersion: "agent-harness.v2", kind: "spawn_subagent", contract: { role: "scout" } },
      { schemaVersion: "agent-harness.v2", kind: "send_message", targetTaskId: "task-1", message: { text: "done" } },
      { schemaVersion: "agent-harness.v2", kind: "wait", taskIds: ["task-1"], timeoutMs: 1_000 },
      { schemaVersion: "agent-harness.v2", kind: "ask_user", question: { text: "Which location?" } },
      { schemaVersion: "agent-harness.v2", kind: "request_approval", request: { action: "resume_upload" } },
      { schemaVersion: "agent-harness.v2", kind: "compact_context", reason: "history is large" },
      { schemaVersion: "agent-harness.v2", kind: "finish", response: { text: "Finished" } },
    ]
    for (const intent of intents) await expect(parseNextStep(JSON.stringify(intent))).resolves.toMatchObject({ step: intent })
  })

  it("does not expose an invalid tool call as executable output", async () => {
    const execute = vi.fn()
    await expect(parseNextStep({ ...toolStep, arguments: ["not", "an", "object"] })).rejects.toBeInstanceOf(NextStepValidationError)
    expect(validateNextStep({ ...toolStep, arguments: ["not", "an", "object"] })).not.toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it("rejects duplicate call ids before the router can execute them", async () => {
    await expect(parseNextStep(toolStep, { seenCallIds: new Set(["call-1"]) })).rejects.toMatchObject({
      issues: [expect.objectContaining({ keyword: "unique" })],
    })
  })

  it("repairs malformed JSON at most once", async () => {
    const repair = vi.fn().mockResolvedValue(toolStep)
    const result = await parseNextStep("truncated", { repair, messages: [] })
    expect(result).toMatchObject({ step: toolStep, repairAttempts: 1 })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair.mock.calls[0][0]).toMatchObject({ attempt: 1 })
  })

  it("fails after one unsuccessful repair without looping", async () => {
    const repair = vi.fn().mockResolvedValue("still invalid")
    await expect(parseNextStep("{", { repair })).rejects.toMatchObject({ repairAttempts: 1 })
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it("turns a repair provider failure into a bounded validation error", async () => {
    const repair = vi.fn().mockRejectedValue(new Error("repair provider unavailable"))
    await expect(parseNextStep("{", { repair })).rejects.toMatchObject({
      repairAttempts: 1, issues: expect.arrayContaining([expect.objectContaining({ keyword: "repair" })]),
    })
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it("validates tool-specific arguments without executing a tool", async () => {
    const validator = vi.fn().mockReturnValue("query is required")
    await expect(parseNextStep(toolStep, { validateToolArguments: validator })).rejects.toMatchObject({
      issues: [expect.objectContaining({ keyword: "toolArguments" })],
    })
    expect(validator).toHaveBeenCalledWith(toolStep)
  })
})
