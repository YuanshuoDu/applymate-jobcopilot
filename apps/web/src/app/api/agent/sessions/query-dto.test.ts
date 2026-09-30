import { describe, expect, it } from "vitest"

import { itemDto, taskDto, turnDto } from "./query-dto"

const date = new Date("2026-08-31T00:00:00Z")

describe("agent query DTO redaction", () => {
  it("projects only referenced, redacted Scout evidence from an exact completed result envelope", () => {
    const result = {
      status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "final-item",
      finalText: "RAW_FINAL_TEXT https://private.example/apply?email=a@example.test",
      structuredResult: {
        schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
        summary: "Found 1 role for Steven Du. Contact: alex@example.test, +1 (415) 555-0133.",
        candidates: Array.from({ length: 6 }, (_, index) => {
          const jobId = `job-${index + 1}`
          return { jobId, source: "greenhouse", url: "https://private.example/apply?token=raw", evidenceIds: [`job-evidence-${index + 1}`, ...(index === 0 ? ["source-evidence"] : [])] }
        }),
        evidence: [
          { id: "job-evidence-1", kind: "job", ref: "job-1", source: "greenhouse" },
          { id: "source-evidence", kind: "source", ref: "jobs.search:run-1", source: "jobs.search" },
          ...Array.from({ length: 5 }, (_, index) => ({ id: `job-evidence-${index + 2}`, kind: "job", ref: `job-${index + 2}`, source: "greenhouse" })),
          { id: "unreferenced", kind: "source", ref: "unreferenced-secret", source: "private-source" },
        ],
      },
    }
    const dto = taskDto({
      id: "task-scout", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, path: "/root/scout",
      role: "scout", taskType: "scout", status: "completed", goal: "Find roles", confidence: null, failureReason: null,
      result, createdAt: date, updatedAt: date,
    })

    expect(dto.structuredEvidencePreview).toEqual({
      role: "scout", summary: "Scout completed: 6 candidates; 7 linked evidence items.", itemCount: 6,
      evidence: [
        { kind: "job", source: "greenhouse", reference: null },
        { kind: "source", source: "jobs.search", reference: null },
        { kind: "job", source: "greenhouse", reference: null },
        { kind: "job", source: "greenhouse", reference: null },
        { kind: "job", source: "greenhouse", reference: null },
      ],
    })
    expect(JSON.stringify(dto)).not.toContain("RAW_FINAL_TEXT")
    expect(JSON.stringify(dto)).not.toContain("private.example")
    expect(JSON.stringify(dto)).not.toContain("unreferenced-secret")
    expect(JSON.stringify(dto)).not.toContain("job-5")
    expect(JSON.stringify(dto)).not.toContain("job-6")
    expect(JSON.stringify(dto)).not.toContain("jobs.search:run-1")
    expect(JSON.stringify(dto)).not.toContain("alex@example.test")
    expect(JSON.stringify(dto)).not.toContain("415")
    expect(JSON.stringify(dto)).not.toContain("Steven Du")
  })

  it("validates the Analyst schema against the task role before projecting its finding evidence", () => {
    const dto = taskDto({
      id: "task-analyst", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, path: "/root/analyst",
      role: "analyst", taskType: "analyst", status: "completed", goal: "Score roles", confidence: null, failureReason: null,
      result: {
        status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "final-item", finalText: "PRIVATE_ANALYST_TEXT",
        structuredResult: {
          schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "partial", summary: "Scored one public job.",
          findings: [{ jobId: "job-42", score: 8, evidenceIds: ["job-evidence"] }],
          evidence: [{ id: "job-evidence", kind: "job", ref: "job-42", source: "greenhouse" }],
        },
      },
      createdAt: date, updatedAt: date,
    })
    expect(dto.structuredEvidencePreview).toEqual({
      role: "analyst", summary: "Analyst partially completed: 1 finding; 1 linked evidence item.", itemCount: 1,
      evidence: [{ kind: "job", source: "greenhouse", reference: null }],
    })
    expect(JSON.stringify(dto)).not.toContain("PRIVATE_ANALYST_TEXT")
  })

  it("fails closed for incomplete, wrong-role, malformed, and oversized structured results", () => {
    const valid = {
      status: "completed", stepCount: 1, toolCallCount: 0, finalItemId: null, finalText: "private",
      structuredResult: {
        schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", summary: "Safe summary",
        candidates: [{ jobId: "job-42", source: "greenhouse", url: null, evidenceIds: ["job-evidence"] }],
        evidence: [{ id: "job-evidence", kind: "job", ref: "job-42", source: "greenhouse" }],
      },
    }
    const row = (result: unknown, role = "scout", status = "completed") => taskDto({
      id: "task-scout", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, path: "/root/scout",
      role, taskType: "scout", status, goal: "Find roles", confidence: null, failureReason: null, result,
      createdAt: date, updatedAt: date,
    })

    expect(row(valid, "analyst")).not.toHaveProperty("structuredEvidencePreview")
    expect(row({ ...valid, status: "failed" })).not.toHaveProperty("structuredEvidencePreview")
    expect(row({ ...valid, extra: "lease metadata" })).not.toHaveProperty("structuredEvidencePreview")
    expect(row({ ...valid, structuredResult: { ...valid.structuredResult, schemaVersion: "unknown" } })).not.toHaveProperty("structuredEvidencePreview")
    expect(row({ ...valid, structuredResult: { ...valid.structuredResult, summary: "x".repeat(8_193) } })).not.toHaveProperty("structuredEvidencePreview")
    expect(row(valid, "scout", "running")).not.toHaveProperty("structuredEvidencePreview")
  })

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
