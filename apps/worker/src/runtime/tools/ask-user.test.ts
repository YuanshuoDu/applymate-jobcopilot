import { describe, expect, it } from "vitest"

import { AskUserInputSchema, AskUserOutputSchema, createAskUserTool } from "./ask-user.js"
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

  it("advertises the 2,000-byte question contract without overstating JSON Schema precision", () => {
    for (const schema of [AskUserInputSchema, AskUserOutputSchema]) {
      expect(schema.properties.question.maxLength).toBe(2_000)
      expect(schema.properties.question.description).toContain("2,000 UTF-8 bytes")
      expect(schema.properties.question.description).toContain("server-side validation")
    }
  })

  it("advertises the 200-byte UTF-8 limit for choice labels and values", () => {
    const choiceSchemas = [
      AskUserInputSchema.properties.choices.items.properties,
      AskUserOutputSchema.properties.options.items.properties,
    ]
    for (const choice of choiceSchemas) {
      for (const field of [choice.label, choice.value]) {
        expect(field.maxLength).toBe(200)
        expect(field.description).toContain("200 UTF-8 bytes")
        expect(field.description).toContain("server-side validation")
      }
    }
  })

  it("accepts 2,000 UTF-8-byte questions and rejects 2,001-byte questions", async () => {
    const asciiLimit = "a".repeat(2_000)
    await expect(tool.execute(root, { question: asciiLimit })).resolves.toMatchObject({ question: asciiLimit })
    await expect(tool.execute(root, { question: "a".repeat(2_001) })).rejects.toMatchObject({ code: "ask_user_input_invalid" })

    const multibyteLimit = "é".repeat(1_000)
    await expect(tool.execute(root, { question: multibyteLimit })).resolves.toMatchObject({ question: multibyteLimit })
    await expect(tool.execute(root, { question: `${"a".repeat(1_999)}é` })).rejects.toMatchObject({ code: "ask_user_input_invalid" })
  })

  it("enforces choice byte boundaries and rejects duplicate values", async () => {
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
