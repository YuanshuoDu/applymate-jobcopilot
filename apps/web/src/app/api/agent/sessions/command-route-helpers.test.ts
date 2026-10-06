import { describe, expect, it } from "vitest"

import { schemaVersion } from "@jobcopilot/agent-protocol"

import { MAX_COMMAND_BODY_BYTES, parseForkBody, parseInterruptBody, parseMessageBody, parseReplaceObjectiveBody, parseRetryBody } from "./command-route-helpers"

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("agent command route boundaries", () => {
  it("builds a protocol-safe message from the URL-owned session", () => {
    const parsed = parseMessageBody({ clientMessageId: "client_1", content: [{ type: "text", text: "Find Dublin jobs" }] }, request({}), "session_1")
    expect(parsed).toMatchObject({ clientMessageId: "client_1", delivery: "steer", expectedTurnId: null })
    expect(parsed).toMatchObject({ content: [{ type: "text", text: "Find Dublin jobs" }] })
  })

  it("parses selected-job preparation as a typed follow-up scope, separate from model content", () => {
    const parsed = parseMessageBody({
      clientMessageId: "prepare_1",
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_1" },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }, request({}), "session_1")

    expect(parsed).toMatchObject({ selectedJobPreparation: { jobId: "job_1" }, delivery: "follow_up" })
    expect((parsed as { content: Array<{ text?: string }> }).content[0]?.text).not.toContain("job_1")
  })

  it("rejects malformed selected-job scope and steer delivery", async () => {
    for (const body of [
      { clientMessageId: "prepare_bad", delivery: "follow_up", selectedJobPreparation: { jobId: "job_1", userId: "other" }, content: [{ type: "text", text: "Prepare" }] },
      { clientMessageId: "prepare_steer", delivery: "steer", selectedJobPreparation: { jobId: "job_1" }, content: [{ type: "text", text: "Prepare" }] },
    ]) {
      const parsed = parseMessageBody(body, request({}), "session_1")
      expect(parsed).toBeInstanceOf(Response)
      await expect((parsed as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
    }
  })

  it("accepts an explicit null expected turn and rejects unknown content fields", async () => {
    const parsed = parseMessageBody({ clientMessageId: "client_1", expectedTurnId: null, content: [{ type: "text", text: "Start", extra: true }] }, request({}), "session_1")
    expect(parsed).toBeInstanceOf(Response)
    await expect((parsed as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })

    const valid = parseMessageBody({ clientMessageId: "client_2", expectedTurnId: null, content: [{ type: "text", text: "Start" }] }, request({}), "session_1")
    expect(valid).toMatchObject({ clientMessageId: "client_2", expectedTurnId: null })
  })

  it("rejects client scope and tool fields", async () => {
    const parsed = parseMessageBody({ clientMessageId: "client_1", userId: "other", tool: { name: "submit_application" }, content: [{ type: "text", text: "run" }] }, request({}), "session_1")
    expect(parsed).toBeInstanceOf(Response)
    await expect((parsed as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
  })

  it("accepts an idempotency header for interrupt and enforces payload size", async () => {
    const parsed = parseInterruptBody({}, request({}, { "idempotency-key": "interrupt_1" }))
    expect(parsed).toEqual({ clientMessageId: "interrupt_1", expectedRevision: null })
    expect(parseInterruptBody({ schemaVersion: "agent-harness.v1", clientMessageId: "interrupt_2" }, request({}))).toBeInstanceOf(Response)
    const oversized = new Request("http://localhost", { method: "POST", body: "x".repeat(MAX_COMMAND_BODY_BYTES + 1) })
    const response = await import("./command-route-helpers").then(({ readJsonBody }) => readJsonBody(oversized))
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(422)
  })

  it("requires a URL-scoped last Turn and accepts edit-as-fork content only", async () => {
    expect(parseForkBody({ clientMessageId: "fork_1", lastTurnId: "turn_1", editContent: [{ type: "text", text: "Use Dublin" }] }, request({}))).toMatchObject({
      clientMessageId: "fork_1", lastTurnId: "turn_1", editContent: [{ type: "text", text: "Use Dublin" }],
    })
    const forbidden = parseForkBody({ clientMessageId: "fork_2", lastTurnId: "turn_1", userId: "other" }, request({}))
    expect(forbidden).toBeInstanceOf(Response)
    await expect((forbidden as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
    const header = parseForkBody({ lastTurnId: "turn_1" }, request({}, { "idempotency-key": "fork_3" }))
    expect(header).toMatchObject({ clientMessageId: "fork_3", lastTurnId: "turn_1" })
  })

  it("parses retry identity from the body or idempotency header and rejects client scope", async () => {
    expect(parseRetryBody({ clientMessageId: "retry_1", expectedRevision: 3 }, request({}))).toEqual({ clientMessageId: "retry_1", expectedRevision: 3 })
    expect(parseRetryBody({ expectedRevision: null }, request({}, { "idempotency-key": "retry_2" }))).toEqual({ clientMessageId: "retry_2", expectedRevision: null })
    const forbidden = parseRetryBody({ clientMessageId: "retry_3", userId: "other" }, request({}))
    expect(forbidden).toBeInstanceOf(Response)
    await expect((forbidden as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
    expect(parseRetryBody({ clientMessageId: "retry_4", schemaVersion: "agent-harness.v0" }, request({}))).toBeInstanceOf(Response)
  })

  it("requires a strict objective replacement identity, current Turn revision, and human text", async () => {
    const body = {
      schemaVersion,
      clientMessageId: "replace_1",
      expectedTurnId: "turn_1",
      expectedRevision: 4,
      content: [{ type: "text", text: "Replace the Berlin search with senior backend roles in Dublin." }],
    }
    expect(parseReplaceObjectiveBody(body, request(body))).toEqual({
      clientMessageId: "replace_1",
      expectedTurnId: "turn_1",
      expectedRevision: 4,
      content: body.content,
    })
    expect(parseReplaceObjectiveBody(body, request(body, { "idempotency-key": "replace_1" }))).toMatchObject({ clientMessageId: "replace_1" })

    const invalidBodies = [
      { ...body, schemaVersion: "agent-harness.v0" },
      { ...body, clientMessageId: undefined },
      { ...body, expectedTurnId: null },
      { ...body, expectedRevision: -1 },
      { ...body, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, content: [{ type: "attachment_ref", attachmentId: "resume_1", mediaType: "application/pdf" }] },
      { ...body, content: [{ type: "text", text: "  " }] },
      { ...body, source: "automation" },
      { ...body, criteria: ["client authority"] },
      { ...body, policy: { allowSubmit: true } },
      { ...body, selectedJobPreparation: { jobId: "job_1" } },
    ]
    for (const invalidBody of invalidBodies) {
      const parsed = parseReplaceObjectiveBody(invalidBody, request(invalidBody))
      expect(parsed).toBeInstanceOf(Response)
      await expect((parsed as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
    }
    expect(parseReplaceObjectiveBody(body, request(body, { "idempotency-key": "different" }))).toBeInstanceOf(Response)
  })

  it("enforces existing content bounds for objective replacement", async () => {
    const parsed = parseReplaceObjectiveBody({
      schemaVersion,
      clientMessageId: "replace_large",
      expectedTurnId: "turn_1",
      expectedRevision: 0,
      content: [{ type: "text", text: "x".repeat(20_001) }],
    }, request({}))
    expect(parsed).toBeInstanceOf(Response)
    await expect((parsed as Response).json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
  })

})
