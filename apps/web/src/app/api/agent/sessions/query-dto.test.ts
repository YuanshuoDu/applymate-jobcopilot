import { describe, expect, it } from "vitest"

import { itemDto, taskDto, turnDto } from "./query-dto"

const date = new Date("2026-08-31T00:00:00Z")

describe("agent query DTO redaction", () => {
  it("redacts sensitive item content while preserving display-safe milestones", () => {
    const dto = itemDto({
      id: "item_1", sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null,
      type: "artifact", status: "completed", phase: "commentary", revision: 1,
      content: { title: "Resume ready", body: "Bearer super-secret-token", data: { apiKey: "secret", resume: "full CV", resumeText: "full CV" } },
      startedAt: null, completedAt: date, createdAt: date, updatedAt: date,
    })
    expect(dto.content).toEqual({ title: "Resume ready", body: "Bearer [REDACTED]", data: { apiKey: "[REDACTED]", resume: "[REDACTED]", resumeText: "[REDACTED]" } })
  })

  it("does not expose turn input, task result, or tool arguments", () => {
    expect(turnDto({
      id: "turn_1", sessionId: "session_1", source: "user", status: "completed", revision: 2,
      input: { goal: "Find Dublin jobs", content: [{ type: "text", text: "private" }] },
      steps: [{ id: "step_1" }], items: [{ id: "item_final" }],
      createdAt: date, updatedAt: new Date("2026-08-31T00:01:00Z"), completedAt: null,
    })).not.toHaveProperty("input")
    expect(taskDto({
      id: "task_1", sessionId: "session_1", role: "scout", taskType: "jobs", status: "passed", goal: "Find jobs",
      confidence: 0.9, failureReason: null, result: { resumeText: "private" }, createdAt: date, updatedAt: date,
    })).toMatchObject({ hasResult: true })
    expect(itemDto({
      id: "tool_1", sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null, type: "tool_call", status: "completed", phase: "commentary", revision: 0,
      content: { toolCallId: "call_1", toolName: "jobs.search", input: { apiKey: "private" } }, startedAt: null, completedAt: null, createdAt: date, updatedAt: date,
    }).content).toEqual({ toolCallId: "call_1", toolName: "jobs.search", inputAvailable: true })
  })

  it("keeps user-visible text and attachment metadata but drops unknown parts", () => {
    expect(itemDto({
      id: "item_2", sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null, type: "user_message", status: "accepted", phase: "input", revision: 1,
      content: { parts: [
        { type: "text", text: "Bearer user-token" },
        { type: "attachment_ref", mediaType: "application/pdf", filename: "resume.pdf", attachmentId: "private-id" },
        { type: "tool_call", input: { password: "private" } },
      ] }, startedAt: null, completedAt: null, createdAt: date, updatedAt: date,
    }).content).toEqual({ parts: [
      { type: "text", text: "Bearer [REDACTED]" },
      { type: "attachment_ref", mediaType: "application/pdf", filename: "resume.pdf" },
    ] })
  })
})
