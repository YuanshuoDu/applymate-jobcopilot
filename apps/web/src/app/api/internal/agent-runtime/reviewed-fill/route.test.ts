import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { processHandoff } = vi.hoisted(() => ({ processHandoff: vi.fn() }))

vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/approval/reviewed-fill-handoff-outbox", () => ({
  processReviewedFillHandoffOutbox: processHandoff,
  ReviewedFillHandoffOutboxNotFoundError: class extends Error {},
}))

import { POST } from "./route"
import { ReviewedFillHandoffOutboxNotFoundError } from "@/lib/agent/approval/reviewed-fill-handoff-outbox"

function request(body: string, headers: Record<string, string> = { "x-agent-worker-secret": "secret" }) {
  return new NextRequest("http://localhost/api/internal/agent-runtime/reviewed-fill", {
    method: "POST", headers, body,
  })
}

describe("internal reviewed fill handoff route", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_WORKER_SECRET", "secret")
    processHandoff.mockReset()
  })

  it("requires the Worker secret and an exact bounded outboxId body", async () => {
    expect((await POST(request('{"outboxId":"outbox_1"}', {}))).status).toBe(401)
    expect((await POST(request('{"outboxId":"outbox_1","extra":true}'))).status).toBe(400)
    expect((await POST(request('{"outboxId":""}'))).status).toBe(400)
    expect((await POST(request(`{"outboxId":"${"x".repeat(1100)}"}`))).status).toBe(400)
    expect(processHandoff).not.toHaveBeenCalled()
  })

  it.each(["queued", "duplicate", "deferred", "terminal"] as const)("returns only %s for a known dispatch", async (status) => {
    processHandoff.mockResolvedValue(status)
    const response = await POST(request('{"outboxId":"outbox_1"}'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status })
    expect(processHandoff).toHaveBeenCalledWith({}, "outbox_1")
  })

  it("keeps unknown rows and transient failures non-200 without leaking details", async () => {
    processHandoff.mockRejectedValueOnce(new ReviewedFillHandoffOutboxNotFoundError())
    const missing = await POST(request('{"outboxId":"foreign"}'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Handoff not found" })
    processHandoff.mockRejectedValueOnce(new Error("private database detail"))
    const failed = await POST(request('{"outboxId":"outbox_1"}'))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: "Handoff unavailable" })
  })
})
