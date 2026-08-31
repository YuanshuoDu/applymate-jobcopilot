import { describe, expect, it } from "vitest"

import { MAX_COMMAND_BODY_BYTES, parseInterruptBody, parseMessageBody } from "./command-route-helpers"

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
})
