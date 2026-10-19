import { describe, expect, it } from "vitest"

import { redactAgentEvent, redactSensitiveValue, type AgentEventRoutingContext } from "./agent-redaction"

const waitId = "70463535-1444-4bba-ae3b-b80578d2dd0a"
const sessionId = "70463535-1444-4bba-ae3b-b80578d2dd0b"
const turnId = "70463535-1444-4bba-ae3b-b80578d2dd0c"
const toolCallId = "70463535-1444-4bba-ae3b-b80578d2dd0d"
const waitItemId = (kind: "approval" | "question") => `agent-wait:${kind}:${waitId}`

function route(type: string, payload: Record<string, unknown>): AgentEventRoutingContext {
  const kind = payload.waitKind as "approval" | "question"
  const itemId = waitItemId(kind)
  if (type === "item.started") return { sessionId, turnId, itemId, taskId: null, actor: "orchestrator", correlationId: itemId, causationId: waitId, outboxTopic: "agent.session.event" }
  if (type === "turn.wakeup") return { sessionId, turnId, itemId, taskId: null, actor: "user", correlationId: turnId, causationId: "70463535-1444-4bba-ae3b-b80578d2dd0e", outboxTopic: "agent.turn.wakeup" }
  return { sessionId, turnId, itemId, taskId: null, actor: "user", correlationId: waitId, causationId: itemId, outboxTopic: "agent.session.event" }
}

describe("agent event redaction", () => {
  it("removes credentials and direct PII while preserving opaque receipt references", () => {
    const safe = redactAgentEvent({
      type: "tool_call.completed",
      body: "Sent to recruiter@example.com from Bearer abcdefghijk",
      data: {
        apiKey: "sk-test-secret-value",
        receiptNonce: "nonce-secret",
        recipientEmail: "recruiter@example.com",
        phone: "+353 87 123 4567",
        status: "sent",
      },
    })

    expect(safe).toMatchInlineSnapshot(`
      {
        "body": "Sent to [REDACTED_EMAIL] from Bearer [REDACTED]",
        "data": {
          "apiKey": "[REDACTED]",
          "phone": "[REDACTED]",
          "receiptNonce": "nonce-secret",
          "recipientEmail": "[REDACTED]",
          "status": "sent",
        },
      }
    `)
  })

  it("does not leak sensitive text through arrays or free-form values", () => {
    const safe = redactSensitiveValue([
      "password=super-secret",
      { answer: "My email is candidate@example.com", ok: true },
    ])

    expect(JSON.stringify(safe)).not.toContain("super-secret")
    expect(JSON.stringify(safe)).not.toContain("candidate@example.com")
    expect(safe).toEqual(["password=[REDACTED]", { answer: "[REDACTED]", ok: true }])
  })

  it("keeps safe automation structure available to the transcript UI", () => {
    const safe = redactAgentEvent({
      type: "automation_draft",
      body: "Review the automation before saving it.",
      data: { draft: { name: "Berlin SWE automation", minScore: 85, autoApply: false } },
    })

    expect(safe.data).toEqual({ draft: { name: "Berlin SWE automation", minScore: 85, autoApply: false } })
  })

  it("preserves stable IDs but redacts unsafe question IDs and phone-like text", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const durableQuestionId = "0123456789abcdef".repeat(4)
    const safe = redactAgentEvent({
      type: "task.updated",
      body: "Call 4912-9422 about this task.",
      data: {
        item: { taskId, questionId: "question-private-note", content: "Call 4912-9422." },
        wait: { questionId: durableQuestionId },
        note: "Call 4912-9422.",
      },
    })

    expect(safe.body).toBe("Call [REDACTED_PHONE] about this task.")
    expect(safe.data).toEqual({
      item: { taskId, questionId: "[REDACTED]", content: "[REDACTED]" },
      wait: { questionId: durableQuestionId },
      note: "Call [REDACTED_PHONE].",
    })
    expect(redactAgentEvent({ type: "task.updated", body: safe.body, data: safe.data })).toEqual(safe)
  })

  it("does not exempt invalid or secret-like values in structural ID fields", () => {
    for (const taskId of ["child-4155550123", "sk_test_private_secret_value"]) {
      const safe = redactAgentEvent({ type: "task.updated", body: "", data: { item: { taskId } } })
      const item = (safe.data as { item: { taskId: string } }).item

      expect(item.taskId).not.toBe(taskId)
      expect(JSON.stringify(safe.data)).not.toContain(taskId)
    }
  })

  it("redacts PII prefixes before stable UUID or hash suffixes in structural IDs", () => {
    const candidates = [
      { value: "candidate@example.com-child-0be414dd-f9ec-4912-9422-a3db3100ea4f", pii: "candidate@example.com" },
      { value: "+1 (415) 555-0198-0123456789abcdef0123456789abcdef", pii: "+1 (415) 555-0198" },
    ]

    for (const candidate of candidates) {
      const safe = redactAgentEvent({ type: "task.updated", body: "", data: { item: { taskId: candidate.value } } })
      const item = (safe.data as { item: { taskId: string } }).item

      expect(item.taskId).not.toBe(candidate.value)
      expect(item.taskId).not.toContain(candidate.pii)
    }
  })

  it("preserves structural IDs beside unrelated schema version metadata", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "task.updated",
      body: "Call 4912-9422 about this task.",
      data: {
        schemaVersion: "report.v1",
        report: { schemaVersion: "report.section.v1" },
        item: { taskId },
        note: "Call 4912-9422.",
      },
    })

    expect(safe.body).toBe("Call [REDACTED_PHONE] about this task.")
    expect(safe.data).toEqual({
      schemaVersion: "report.v1",
      report: { schemaVersion: "report.section.v1" },
      item: { taskId },
      note: "Call [REDACTED_PHONE].",
    })
  })

  it("preserves follow-up IDs inside versioned AgentItem payloads while redacting text", () => {
    const messageId = "12345678-1234-5678-1234-123456789011"
    const itemId = "12345678-1234-5678-1234-123456789012"
    const taskId = "child-12345678-1234-5678-1234-123456789013"
    const result = redactAgentEvent({
      type: "input.accepted",
      body: "Call 4912-9422 about this follow-up.",
      data: {
        messageId,
        clientMessageId: "client-once",
        delivery: "follow_up",
        source: "user",
        disposition: "queued_follow_up",
        targetAttemptCount: 2,
        item: {
          schemaVersion: "agent-harness.v2",
          id: itemId,
          sessionId,
          turnId,
          stepId: null,
          taskId,
          type: "user_message",
          status: "completed",
          phase: "commentary",
          revision: 0,
          content: { parts: [{ type: "text", text: "Call 4912-9422." }] },
          startedAt: "2026-10-06T17:30:00.000Z",
          completedAt: "2026-10-06T17:30:00.000Z",
          createdAt: "2026-10-06T17:30:00.000Z",
          updatedAt: "2026-10-06T17:30:00.000Z",
        },
      },
    })
    const safe = result.data as {
      messageId: string
      item: { id: string; taskId: string; content: unknown }
    }

    expect(result.body).toBe("Call [REDACTED_PHONE] about this follow-up.")
    expect(safe.messageId).toBe(messageId)
    expect(safe.item.id).toBe(itemId)
    expect(safe.item.taskId).toBe(taskId)
    expect(safe.item.content).toBe("[REDACTED]")
    const serialized = JSON.stringify(safe)
    for (const id of [messageId, itemId, taskId]) expect(serialized).toContain(id)
    expect(serialized).not.toContain("Call 4912-9422.")
  })

  it("redacts IDs from a partial v2 item-shaped object", () => {
    const ids = {
      id: "12345678-1234-5678-1234-123456789031",
      sessionId: "session-12345678-1234-5678-1234-123456789032",
      turnId: "turn-12345678-1234-5678-1234-123456789033",
      taskId: "child-12345678-1234-5678-1234-123456789034",
    }
    const safe = redactAgentEvent({
      type: "input.accepted",
      body: "",
      data: {
        item: {
          schemaVersion: "agent-harness.v2",
          ...ids,
          type: "user_message",
          status: "completed",
          stepId: null,
          createdAt: "2026-10-06T17:30:00.000Z",
          updatedAt: "2026-10-06T17:30:00.000Z",
        },
      },
    }).data as { item: { id: string; sessionId: string; turnId: string; taskId: string } }

    expect(safe.item).toEqual({ id: "[REDACTED]", sessionId: "[REDACTED]", turnId: "[REDACTED]", taskId: "[REDACTED]",
      schemaVersion: "agent-harness.v2", type: "user_message", status: "completed", stepId: null,
      createdAt: "2026-10-06T17:30:00.000Z", updatedAt: "2026-10-06T17:30:00.000Z" })
    const serialized = JSON.stringify(safe)
    for (const id of Object.values(ids)) expect(serialized).not.toContain(id)
  })

  it("fails closed for a malformed versioned AgentEvent nested under item", () => {
    const ids = {
      id: "12345678-1234-5678-1234-123456789021",
      sessionId: "session-12345678-1234-5678-1234-123456789022",
      turnId: "turn-12345678-1234-5678-1234-123456789023",
      taskId: "child-12345678-1234-5678-1234-123456789024",
    }
    const safe = redactAgentEvent({
      type: "input.accepted",
      body: "",
      data: {
        item: {
          schemaVersion: "agent-harness.v2",
          ...ids,
          type: "future.agent.event",
          status: "completed",
          stepId: null,
          createdAt: "2026-10-06T17:30:00.000Z",
          updatedAt: "2026-10-06T17:30:00.000Z",
          payload: { taskId: ids.taskId },
        },
      },
    }).data as { item: { id: string; sessionId: string; turnId: string; taskId: string; payload: { taskId: string } } }

    expect(safe.item).toMatchObject({
      id: "[REDACTED]", sessionId: "[REDACTED]", turnId: "[REDACTED]", taskId: "[REDACTED]",
      payload: { taskId: "[REDACTED]" },
    })
    const serialized = JSON.stringify(safe)
    for (const id of Object.values(ids)) expect(serialized).not.toContain(id)
  })

  it("redacts IDs in unsupported versioned envelopes with partial identity", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: { schemaVersion: "agent-harness.v3", type: "future.agent.event", taskId },
    }).data as Record<string, unknown>

    expect(safe.taskId).not.toBe(taskId)
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("fails closed when conflicting case-variant schema versions wrap an AgentEvent", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: {
        SchemaVersion: "report.v1",
        schemaVersion: "agent-harness.v3",
        id: "70463535-1444-4bba-ae3b-b80578d2dd0f",
        sessionId,
        turnId,
        type: "future.agent.event",
        taskId,
        payload: { taskId },
      },
    }).data as { taskId: string; payload: { taskId: string } }

    expect(safe.taskId).toBe("[REDACTED]")
    expect(safe.payload.taskId).toBe("[REDACTED]")
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("redacts opaque structural IDs from unsupported AgentEvent versions", () => {
    const ids = {
      id: "event_opaque_93a1",
      sessionId: "session_opaque_27b4",
      turnId: "turn_opaque_815e",
      taskId: "task_opaque_54c2",
      nestedTaskId: "child_opaque_741d",
    }
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: {
        schemaVersion: "agent-harness.v3",
        id: ids.id,
        sessionId: ids.sessionId,
        turnId: ids.turnId,
        type: "future.agent.event",
        taskId: ids.taskId,
        payload: { taskId: ids.nestedTaskId },
      },
    }).data as { id: string; sessionId: string; turnId: string; taskId: string; payload: { taskId: string } }

    expect(safe).toEqual({
      schemaVersion: "agent-harness.v3",
      id: "[REDACTED]",
      sessionId: "[REDACTED]",
      turnId: "[REDACTED]",
      type: "future.agent.event",
      taskId: "[REDACTED]",
      payload: { taskId: "[REDACTED]" },
    })
    const serialized = JSON.stringify(safe)
    for (const id of Object.values(ids)) expect(serialized).not.toContain(id)
    for (const suffix of ["93a1", "27b4", "815e", "54c2", "741d"]) expect(serialized).not.toContain(suffix)
  })

  it("redacts IDs in incomplete Agent namespace envelopes without anchors", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: { schemaVersion: "agent-harness.v3", item: { taskId } },
    }).data as { item: { taskId: string } }

    expect(safe.item.taskId).not.toBe(taskId)
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("preserves structural IDs in unrelated versioned payloads with event-like fields", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "report.updated",
      body: "Call 4912-9422 about this report.",
      data: {
        schemaVersion: "report.v1",
        type: "report.updated",
        taskId,
        payload: { taskId, note: "Call 4912-9422." },
      },
    })

    expect(safe.body).toBe("Call [REDACTED_PHONE] about this report.")
    expect(safe.data).toEqual({
      schemaVersion: "report.v1",
      type: "report.updated",
      taskId,
      payload: { taskId, note: "Call [REDACTED_PHONE]." },
    })
  })

  it("redacts IDs in unsupported versioned envelopes with payload only", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: { schemaVersion: "agent-harness.v3", payload: { taskId } },
    }).data as { payload: { taskId: string } }

    expect(safe.payload.taskId).not.toBe(taskId)
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("redacts IDs in Agent namespace payloads with nonstandard version suffixes", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: { schemaVersion: "agent-harness.v3-beta", payload: { taskId } },
    }).data as { payload: { taskId: string } }

    expect(safe.payload.taskId).not.toBe(taskId)
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("redacts IDs when a non-string schema version accompanies a payload", () => {
    const taskId = "child-0be414dd-f9ec-4912-9422-a3db3100ea4f"
    const safe = redactAgentEvent({
      type: "future.agent.event",
      body: "",
      data: { schemaVersion: 3, payload: { taskId } },
    }).data as { payload: { taskId: string } }

    expect(safe.payload.taskId).not.toBe(taskId)
    expect(JSON.stringify(safe)).not.toContain(taskId)
  })

  it("requires validated routing before preserving IDs from routed payloads or event envelopes", () => {
    const candidateTaskId = "task-70463535-1444-4bba-ae3b-b80578d2dd0a"
    const intentId = "70463535-1444-4bba-ae3b-b80578d2dd0e"
    const payload = { intentId, taskId: candidateTaskId, status: "accepted" }
    const invalidRouting: AgentEventRoutingContext = {
      sessionId, turnId, itemId: null, taskId: candidateTaskId, actor: "user",
      correlationId: turnId, causationId: null, outboxTopic: "agent.turn.wakeup",
    }
    const direct = redactAgentEvent({ type: "task.interrupt.accepted", body: "", data: payload, routing: invalidRouting }).data as Record<string, unknown>
    expect(direct.taskId).not.toBe(candidateTaskId)

    const malformedEnvelope = {
      schemaVersion: "agent-harness.v2", id: "70463535-1444-4bba-ae3b-b80578d2dd0f", sessionId, turnId,
      itemId: null, taskId: candidateTaskId, sequence: "1", type: "task.interrupt.accepted", actor: "user",
      correlationId: "70463535-1444-4bba-ae3b-b80578d2dd01", causationId: null,
      idempotencyKey: "accepted:attempt_1", payload,
    }
    const safeEnvelope = redactAgentEvent({ type: "task.interrupt.accepted", body: "", data: malformedEnvelope }).data as Record<string, unknown>
    expect(safeEnvelope.taskId).not.toBe(candidateTaskId)
    expect((safeEnvelope.payload as Record<string, unknown>).taskId).not.toBe(candidateTaskId)

    const { schemaVersion, ...missingSchemaVersion } = malformedEnvelope
    expect(schemaVersion).toBe("agent-harness.v2")
    for (const candidate of [{ ...malformedEnvelope, schemaVersion: "agent-harness.v3" }, missingSchemaVersion]) {
      const safe = redactAgentEvent({ type: "task.interrupt.accepted", body: "", data: candidate }).data as Record<string, unknown>
      expect(safe.taskId).not.toBe(candidateTaskId)
      expect((safe.payload as Record<string, unknown>).taskId).not.toBe(candidateTaskId)
    }

    const numericUuidTaskId = "12345678-1234-5678-9012-123456789012"
    const partialEnvelope = {
      id: "70463535-1444-4bba-ae3b-b80578d2dd0f", sessionId, turnId, type: "future.agent.event",
      taskId: numericUuidTaskId, payload: { taskId: numericUuidTaskId },
    }
    const safePartialEnvelope = redactAgentEvent({ type: "future.agent.event", body: "", data: partialEnvelope }).data as Record<string, unknown>
    expect(safePartialEnvelope.taskId).not.toBe(numericUuidTaskId)
    expect((safePartialEnvelope.payload as Record<string, unknown>).taskId).not.toBe(numericUuidTaskId)

    const partialWithoutPayload = {
      id: "70463535-1444-4bba-ae3b-b80578d2dd0f", sessionId, turnId, type: "future.agent.event", taskId: numericUuidTaskId,
    }
    const safeWithoutPayload = redactAgentEvent({ type: "future.agent.event", body: "", data: partialWithoutPayload }).data as Record<string, unknown>
    expect(safeWithoutPayload.taskId).not.toBe(numericUuidTaskId)
  })

  it("does not restore generic ID exemptions for wrapped malformed or unsupported envelopes", () => {
    const candidateTaskId = "task-70463535-1444-4bba-ae3b-b80578d2dd0a"
    const envelopeId = "70463535-1444-4bba-ae3b-b80578d2dd0f"
    const envelopes: Array<Record<string, unknown>> = [
      {
        schemaVersion: "agent-harness.v3", id: envelopeId, sessionId, turnId, type: "future.agent.event",
        taskId: candidateTaskId, payload: { taskId: candidateTaskId },
      },
      {
        id: envelopeId, sessionId, turnId, type: "future.agent.event",
        taskId: candidateTaskId, payload: { taskId: candidateTaskId },
      },
      {
        SchemaVersion: "agent-harness.v2", Id: envelopeId, SessionId: sessionId, TurnId: turnId, Type: "future.agent.event",
        TaskId: candidateTaskId, Payload: { TaskId: candidateTaskId },
      },
    ]

    for (const envelope of envelopes) {
      const safe = redactAgentEvent({ type: "future.agent.event", body: "", data: { metadata: envelope } }).data as {
        metadata: { taskId?: string; TaskId?: string; payload?: { taskId?: string }; Payload?: { TaskId?: string } }
      }
      const metadata = safe.metadata
      expect(JSON.stringify(metadata)).not.toContain(candidateTaskId)
    }
  })

  it("keeps opaque approval references and omits absent optional values", () => {
    const safe = redactAgentEvent({
      type: "automation_draft",
      body: "Review the automation before saving it.",
      data: {
        draft: { name: "Berlin SWE automation", triggerType: "weekdays" },
        approval: { id: "approval_1", receiptNonce: undefined, scopeHash: "hash_1" },
      },
    })

    expect(safe.data).toEqual({
      draft: { name: "Berlin SWE automation", triggerType: "weekdays" },
      approval: { id: "approval_1", scopeHash: "hash_1" },
    })
  })

  it("keeps resume metadata but removes the resume content", () => {
    const safe = redactAgentEvent({
      type: "resume_tailored",
      body: "A tailored resume is ready.",
      data: { resume: { id: "resume_1", name: "Tailored CV", content: { summary: "private history" } } },
    })

    expect(safe.data).toEqual({ resume: { id: "resume_1", name: "Tailored CV", content: "[REDACTED]" } })
  })

  it("preserves only validated question and approval routing identities", () => {
    const cases = [
      { type: "item.started", kind: "question" as const, payload: { waitKind: "question", questionId: waitId, itemId: waitItemId("question"), toolCallId } },
      { type: "item.started", kind: "approval" as const, payload: { waitKind: "approval", approvalId: waitId, itemId: waitItemId("approval"), toolCallId } },
      { type: "question.answered", kind: "question" as const, payload: { waitKind: "question", waitId, itemId: waitItemId("question"), turnId, toolCallId, status: "answered", nextTurnRevision: 9, answerAvailable: true, answer: "candidate@example.com" } },
      { type: "approval.resolved", kind: "approval" as const, payload: { waitKind: "approval", waitId, itemId: waitItemId("approval"), turnId, toolCallId: null, status: "approved", nextTurnRevision: 9, answerAvailable: false } },
      { type: "approval.resolved", kind: "approval" as const, payload: { waitKind: "approval", waitId, itemId: waitItemId("approval"), turnId, toolCallId, status: "rejected", nextTurnRevision: 9, answerAvailable: false } },
      { type: "turn.wakeup", kind: "question" as const, payload: { waitKind: "question", waitId, itemId: waitItemId("question"), turnId, toolCallId, status: "answered", nextTurnRevision: 9, answerAvailable: true } },
      { type: "turn.wakeup", kind: "approval" as const, payload: { waitKind: "approval", waitId, itemId: waitItemId("approval"), turnId, toolCallId, status: "approved", nextTurnRevision: 9, answerAvailable: false } },
    ]

    for (const testCase of cases) {
      const safe = redactAgentEvent({ type: testCase.type, body: "", data: testCase.payload, routing: route(testCase.type, testCase.payload) })
      const data = safe.data as Record<string, unknown>
      expect(data.itemId).toBe(waitItemId(testCase.kind))
      expect(data[testCase.type === "item.started" ? `${testCase.kind}Id` : "waitId"]).toBe(waitId)
      expect(data.toolCallId).toBe(testCase.payload.toolCallId)
      if (testCase.type === "question.answered") expect(data.answer).toBe("[REDACTED]")
    }
  })

  it("redacts malformed, foreign, unknown, phone-like, and secret-looking routing values", () => {
    const payload = { waitKind: "question", waitId, itemId: waitItemId("question"), turnId, toolCallId, status: "answered", nextTurnRevision: 2 }
    const validRoute = route("question.answered", payload)
    const foreign = redactAgentEvent({ type: "question.answered", body: "", data: payload,
      routing: { ...validRoute, correlationId: "other_question" } }).data as Record<string, unknown>
    const unknown = redactAgentEvent({ type: "unknown.event", body: "", data: payload, routing: validRoute }).data as Record<string, unknown>
    const invalid = redactAgentEvent({ type: "question.answered", body: "", data: { ...payload, waitId: "4155550123" },
      routing: { ...validRoute, correlationId: "4155550123" } }).data as Record<string, unknown>
    expect(foreign.waitId).not.toBe(waitId)
    expect(unknown.waitId).not.toBe(waitId)
    expect(invalid.waitId).not.toBe("4155550123")
    expect(redactAgentEvent({ type: "question.answered", body: "", data: payload }).data).not.toEqual(payload)
    for (const secretId of ["sk-live-secret-value", "sk_test_secret_value", "ghp_0123456789abcdef", "github_pat_0123456789abcdef", "xoxb-1234567890abcdef"]) {
      const secretItemId = `agent-wait:question:${secretId}`
      const secret = redactAgentEvent({ type: "question.answered", body: "", data: { ...payload, waitId: secretId, itemId: secretItemId },
        routing: { ...validRoute, itemId: secretItemId, correlationId: secretId, causationId: secretItemId } }).data as Record<string, unknown>
      expect(secret.waitId).toBe("[REDACTED]")
    }
  })

  it("keeps valid legacy approval correlation and re-redacted canonical envelopes aligned", () => {
    const legacy = redactAgentEvent({ type: "approval.resolved", body: "", data: { approvalId: waitId, action: "apply", scopeHash: "hash_1", revision: 3 },
      routing: { sessionId, turnId, itemId: null, taskId: null, actor: "system", correlationId: waitId, causationId: toolCallId, outboxTopic: "agent.session.event" } })
    expect(legacy.data).toMatchObject({ approvalId: waitId, scopeHash: "hash_1" })

    const raw = { schemaVersion: "agent-harness.v2", id: "70463535-1444-4bba-ae3b-b80578d2dd0f", sessionId, turnId, itemId: waitItemId("question"), taskId: null,
      sequence: "7046353541444", type: "turn.wakeup", actor: "user", correlationId: turnId, causationId: "70463535-1444-4bba-ae3b-b80578d2dd0e",
      createdAt: "2026-10-06T17:30:00.000Z",
      idempotencyKey: "agent-wait-command:manual_retry_1:wakeup", payload: { waitKind: "question", waitId, itemId: waitItemId("question"), turnId, toolCallId,
        status: "answered", nextTurnRevision: 9, answerAvailable: true, answer: "candidate@example.com" } }
    const once = redactAgentEvent({ type: "turn.wakeup", body: "", data: raw }).data
    const twice = redactAgentEvent({ type: "turn.wakeup", body: "", data: once }).data as Record<string, unknown>
    const payload = twice.payload as Record<string, unknown>
    expect(twice).toMatchObject({ schemaVersion: raw.schemaVersion, id: raw.id, sessionId, turnId, itemId: waitItemId("question"),
      taskId: null, actor: "user", correlationId: turnId, causationId: raw.causationId, idempotencyKey: raw.idempotencyKey, createdAt: raw.createdAt })
    expect(twice.sequence).toBe(raw.sequence)
    expect(payload).toMatchObject({ waitId, itemId: waitItemId("question"), turnId, toolCallId, answer: "[REDACTED]" })

    const malformed = redactAgentEvent({ type: "turn.wakeup", body: "", data: { ...raw, correlationId: sessionId } }).data as Record<string, unknown>
    expect(malformed.id).not.toBe(raw.id)
    expect((malformed.payload as Record<string, unknown>).waitId).not.toBe(waitId)
    const invalidSequence = redactAgentEvent({ type: "turn.wakeup", body: "", data: { ...raw, sequence: "9e12" } }).data as Record<string, unknown>
    expect(invalidSequence.id).not.toBe(raw.id)
    const invalidIdempotencyKey = redactAgentEvent({ type: "turn.wakeup", body: "", data: { ...raw, idempotencyKey: "x".repeat(257) } }).data as Record<string, unknown>
    expect(invalidIdempotencyKey.id).not.toBe(raw.id)
    const emailKey = `agent-wait-command:candidate@example.com:wakeup`
    const emailEnvelope = redactAgentEvent({ type: "turn.wakeup", body: "", data: { ...raw, idempotencyKey: emailKey } }).data as Record<string, unknown>
    expect(emailEnvelope.id).toBe(raw.id)
    expect(emailEnvelope.itemId).toBe(raw.itemId)
    expect(emailEnvelope.sequence).toBe(raw.sequence)
    expect(emailEnvelope.idempotencyKey).toBe("agent-wait-command:[REDACTED_EMAIL]:wakeup")
    const secretKey = "agent-wait-command:sk_test_private_secret:wakeup"
    const secretEnvelope = redactAgentEvent({ type: "turn.wakeup", body: "", data: { ...raw, idempotencyKey: secretKey } }).data as Record<string, unknown>
    expect(secretEnvelope.id).toBe(raw.id)
    expect(secretEnvelope.idempotencyKey).not.toBe(secretKey)
    expect(JSON.stringify(secretEnvelope)).not.toContain("sk_test_private_secret")
    const itemId = waitItemId("approval")
    const started = {
      ...raw, itemId, type: "item.started", actor: "orchestrator", correlationId: itemId, causationId: waitId,
      idempotencyKey: `agent-wait:${itemId}:started`,
      payload: { itemId, waitKind: "approval", approvalId: waitId, toolCallId },
    }
    const startedOnce = redactAgentEvent({ type: "item.started", body: "", data: started }).data
    const startedTwice = redactAgentEvent({ type: "item.started", body: "", data: startedOnce }).data as Record<string, unknown>
    expect(startedTwice).toMatchObject({ id: started.id, itemId, sequence: raw.sequence, idempotencyKey: started.idempotencyKey })
    const legacyMismatch = redactAgentEvent({ type: "approval.resolved", body: "", data: { approvalId: waitId, action: "apply", revision: 1 },
      routing: { sessionId, turnId, itemId: null, taskId: null, actor: "system", correlationId: "other_approval", causationId: toolCallId, outboxTopic: "agent.session.event" } }).data as Record<string, unknown>
    expect(legacyMismatch.approvalId).not.toBe(waitId)
  })

  it("preserves only the validated answer-available flag in the actual answered-event envelope", () => {
    const itemId = waitItemId("question")
    const raw = {
      schemaVersion: "agent-harness.v2", id: "70463535-1444-4bba-ae3b-b80578d2dd10", sessionId, turnId,
      itemId, taskId: null, sequence: "7046353541445", type: "question.answered", actor: "user",
      correlationId: waitId, causationId: itemId, idempotencyKey: "agent-wait-command:answer_retry_1",
      createdAt: "2026-10-06T17:30:00.000Z",
      payload: { waitKind: "question", waitId, itemId, turnId, toolCallId, status: "answered", nextTurnRevision: 9,
        answerAvailable: true, answer: "candidate@example.com" },
    }
    const once = redactAgentEvent({ type: "question.answered", body: "", data: raw }).data
    const twice = redactAgentEvent({ type: "question.answered", body: "", data: once }).data as Record<string, unknown>
    const payload = twice.payload as Record<string, unknown>

    expect(twice).toMatchObject({ schemaVersion: raw.schemaVersion, id: raw.id, sessionId, turnId, itemId,
      taskId: null, sequence: raw.sequence, correlationId: waitId, causationId: itemId, idempotencyKey: raw.idempotencyKey })
    expect(payload).toMatchObject({ waitKind: "question", waitId, itemId, turnId, toolCallId, status: "answered",
      nextTurnRevision: 9, answerAvailable: true, answer: "[REDACTED]" })
    expect(JSON.stringify(twice)).not.toContain("candidate@example.com")

    const nestedDuplicate = {
      ...raw,
      payload: { ...raw.payload, metadata: { SchemaVersion: "report.v1", schemaVersion: "agent-harness.v3", taskId: "task_nested_opaque_85d4" } },
    }
    const duplicateEnvelopes = [{ ...raw, SchemaVersion: "report.v1" }, nestedDuplicate]
    const structuralIds = [raw.id, raw.sessionId, raw.turnId, raw.itemId, raw.correlationId, raw.causationId,
      raw.payload.waitId, raw.payload.itemId, raw.payload.turnId, raw.payload.toolCallId, "task_nested_opaque_85d4"]

    for (const envelope of duplicateEnvelopes) {
      const ambiguous = redactAgentEvent({ type: "question.answered", body: "", data: envelope }).data as {
        id: string; sessionId: string; turnId: string; itemId: string; correlationId: string; causationId: string
        taskId: null; payload: { waitId: string; itemId: string; turnId: string; toolCallId: string }
      }
      expect(ambiguous).toMatchObject({ id: "[REDACTED]", sessionId: "[REDACTED]", turnId: "[REDACTED]",
        itemId: "[REDACTED]", correlationId: "[REDACTED]", causationId: "[REDACTED]", taskId: null,
        payload: { waitId: "[REDACTED]", itemId: "[REDACTED]", turnId: "[REDACTED]", toolCallId: "[REDACTED]" } })
      const serialized = JSON.stringify(ambiguous)
      for (const id of structuralIds) expect(serialized).not.toContain(id)
    }
  })
})
