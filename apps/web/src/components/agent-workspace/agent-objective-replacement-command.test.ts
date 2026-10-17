import { describe, expect, it, vi } from "vitest"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import {
  ObjectiveReplacementCommandError,
  replaceAgentObjective,
  type ReplaceAgentObjectiveRequest,
} from "./agent-objective-replacement-command"

const request: ReplaceAgentObjectiveRequest = {
  sessionId: "session/one",
  expectedTurnId: "turn_1",
  expectedRevision: 4,
  clientMessageId: "objective-message-1",
  text: "  Find backend roles in Dublin  ",
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe("replaceAgentObjective", () => {
  it("posts only the strict objective command envelope with matching idempotency key", async () => {
    const result = { inputId: "input_1", turnId: "turn_2", disposition: "started", sequence: "7" }
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, result))

    await expect(replaceAgentObjective(request, fetcher)).resolves.toEqual(result)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("/api/agent/sessions/session%2Fone/replace-objective")
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": request.clientMessageId },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion,
      clientMessageId: request.clientMessageId,
      expectedTurnId: request.expectedTurnId,
      expectedRevision: request.expectedRevision,
      content: [{ type: "text", text: "Find backend roles in Dublin" }],
    })
  })

  it("accepts exactly 2,000 UTF-8 bytes including multibyte text without truncating", async () => {
    const text = "你".repeat(666) + "ab"
    expect(new TextEncoder().encode(text).byteLength).toBe(2_000)
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, {
      inputId: "input_1", turnId: "turn_2", disposition: "started", sequence: "7",
    }))

    await replaceAgentObjective({ ...request, text }, fetcher)

    const init = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      content: [{ type: "text", text }],
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects multibyte text beyond 2,000 UTF-8 bytes without truncating or fetching", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, {}))
    await expect(replaceAgentObjective({ ...request, text: "你".repeat(667) }, fetcher))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("parses duplicate acceptance and preserves its original disposition", async () => {
    const duplicate = {
      inputId: "input_1",
      turnId: "turn_2",
      disposition: "duplicate",
      originalDisposition: "started",
      sequence: "7",
      ignoredServerField: "not exposed",
    }
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, duplicate))

    await expect(replaceAgentObjective(request, fetcher)).resolves.toEqual({
      inputId: "input_1",
      turnId: "turn_2",
      disposition: "duplicate",
      originalDisposition: "started",
      sequence: "7",
    })
  })

  it("preserves a typed 409 and does not retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(409, {
      error: { code: "active_turn_changed", message: "The active Turn changed", details: { expectedTurnId: "turn_1" } },
    }))

    await expect(replaceAgentObjective(request, fetcher)).rejects.toMatchObject({
      name: "ObjectiveReplacementCommandError",
      status: 409,
      code: "active_turn_changed",
      message: "The active Turn changed",
      details: { expectedTurnId: "turn_1" },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("does not send invalid identifiers, revisions, or text", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, {}))
    const invalidRequests: ReplaceAgentObjectiveRequest[] = [
      { ...request, sessionId: "" },
      { ...request, expectedTurnId: " " },
      { ...request, clientMessageId: "x".repeat(257) },
      { ...request, expectedRevision: -1 },
      { ...request, expectedRevision: 1.5 },
      { ...request, text: "  " },
      { ...request, text: "x".repeat(2_001) },
      { ...request, text: "你".repeat(667) },
    ]

    for (const invalid of invalidRequests) {
      await expect(replaceAgentObjective(invalid, fetcher)).rejects.toBeInstanceOf(ObjectiveReplacementCommandError)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("keeps network failures uncertain and never retries automatically", async () => {
    const networkError = new Error("connection lost")
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => { throw networkError })

    await expect(replaceAgentObjective(request, fetcher)).rejects.toBe(networkError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("narrows malformed HTTP and success JSON without trusting arbitrary fields", async () => {
    const httpFetcher = vi.fn<typeof fetch>(async (_input, _init) => response(500, { error: "private detail" }))
    await expect(replaceAgentObjective(request, httpFetcher)).rejects.toMatchObject({
      status: 500,
      code: "command_failed",
      message: "Objective replacement failed (500)",
      details: {},
    })

    const successFetcher = vi.fn<typeof fetch>(async (_input, _init) => response(202, {
      inputId: "input_1", turnId: "turn_2", sequence: "7", disposition: "started",
      originalDisposition: "unexpected",
    }))
    await expect(replaceAgentObjective(request, successFetcher)).rejects.toThrow("invalid original disposition")
    expect(httpFetcher).toHaveBeenCalledTimes(1)
    expect(successFetcher).toHaveBeenCalledTimes(1)
  })
})