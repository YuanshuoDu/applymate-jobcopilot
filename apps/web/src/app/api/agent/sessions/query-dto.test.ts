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
      id: "task_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "task_1", parentTaskId: null, path: "/task_1",
      role: "scout", taskType: "jobs", status: "passed", goal: "Find jobs",
      confidence: 0.9, failureReason: null, result: { resumeText: "private" }, createdAt: date, updatedAt: date,
    })).toMatchObject({ hasResult: true, turnId: "turn_1", rootTaskId: "task_1", parentTaskId: null, path: "/task_1" })
    expect(taskDto({
      id: "task_child", sessionId: "session_1", turnId: "turn_1", rootTaskId: "task_1", parentTaskId: "task_1", path: "/task_1/task_child",
      role: "worker", taskType: "search", status: "running", goal: "Search jobs",
      confidence: null, failureReason: null, result: null, createdAt: date, updatedAt: date,
    })).toEqual(expect.objectContaining({ turnId: "turn_1", parentTaskId: "task_1" }))
    expect(taskDto({
      id: "task_cross", sessionId: "session_2", turnId: "turn_other", rootTaskId: "task_cross", parentTaskId: null, path: "/task_cross",
      role: "worker", taskType: "search", status: "queued", goal: "Other session", confidence: null,
      failureReason: null, result: null, createdAt: date, updatedAt: date,
    })).not.toHaveProperty("result")
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

  it("projects refreshable waits without returning the private answer or receipt payload", () => {
    const dto = itemDto({
      id: "agent-wait:question:q1", sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null,
      type: "question", status: "completed", phase: "commentary", revision: 1,
      content: { waitKind: "question", questionId: "q1", toolCallId: "call_1", stage: "profile", question: "Work authorisation?", options: [{ value: "yes", label: "Yes" }], answer: "secret-answer", answerAvailable: true },
      startedAt: date, completedAt: date, createdAt: date, updatedAt: date,
    })
    expect(dto.content).toEqual({
      waitKind: "question", questionId: "q1", toolCallId: "call_1", stage: "profile", question: "Work authorisation?",
      options: [{ value: "yes", label: "Yes" }], answerAvailable: true, pending: false,
    })
    expect(JSON.stringify(dto.content)).not.toContain("secret-answer")
  })
})
