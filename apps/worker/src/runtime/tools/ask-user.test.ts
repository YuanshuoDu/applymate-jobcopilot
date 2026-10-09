import { describe, expect, it } from "vitest"

import { createAskUserTool } from "./ask-user.js"
import type { ToolExecutionContext } from "./types.js"

const root: ToolExecutionContext = {
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", signal: new AbortController().signal,
  capabilities: ["canManageChildren"], reportProgress: async () => undefined,
}

describe("agent.ask_user", () => {
  const tool = createAskUserTool()

  it("returns a bounded broker intent without any server-selected identity", async () => {
    await expect(tool.execute(root, { question: "  Which location?  ", choices: [{ label: "Berlin", value: " berlin " }] })).resolves.toEqual({
      schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
      question: "Which location?", options: [{ label: "Berlin", value: "berlin" }],
    })
  })

  it("represents free text with an empty options list", async () => {
    await expect(tool.execute(root, { question: "What date works?" })).resolves.toMatchObject({ question: "What date works?", options: [] })
  })

  it("accepts the UTF-8 question and choice byte boundaries but rejects oversize or duplicate values", async () => {
    await expect(tool.execute(root, { question: "é".repeat(1_000) })).resolves.toMatchObject({ question: "é".repeat(1_000) })
    await expect(tool.execute(root, { question: "é".repeat(1_001) })).rejects.toMatchObject({ code: "ask_user_input_invalid" })
    await expect(tool.execute(root, { question: "Question?", choices: [{ label: "é".repeat(100), value: "a" }] })).resolves.toBeDefined()
    await expect(tool.execute(root, { question: "Question?", choices: [{ label: "é".repeat(101), value: "a" }] })).rejects.toMatchObject({ code: "ask_user_input_invalid" })
    await expect(tool.execute(root, { question: "Question?", choices: [{ label: "A", value: "same" }, { label: "B", value: "same" }] })).rejects.toMatchObject({ code: "ask_user_input_invalid" })
  })

  it("rejects model-supplied identity fields and non-root actors", async () => {
    await expect(tool.execute(root, { question: "Continue?", turnId: "other" } as never)).rejects.toMatchObject({ code: "ask_user_input_invalid" })
    await expect(tool.execute({ ...root, taskId: "child-1", actorRole: "subagent" }, { question: "Continue?" })).rejects.toMatchObject({ code: "ask_user_root_only" })
    await expect(tool.execute({ ...root, capabilities: [] }, { question: "Continue?" })).rejects.toMatchObject({ code: "ask_user_root_only" })
  })
})
