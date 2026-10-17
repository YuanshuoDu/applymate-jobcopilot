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
  })
})
