import { describe, expect, it, vi } from "vitest"

import { postSelectedJobPreparation, SelectedJobPreparationError } from "./selected-job-preparation-action"

describe("selected-job preparation command", () => {
  it("sends a typed selected job ID outside the generic model message", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ inputId: "input-1", turnId: "turn-1", disposition: "started", sequence: "1" }, { status: 202 }))
    await expect(postSelectedJobPreparation({ sessionId: "session/1", jobId: "job/42", clientMessageId: "message-1" }, fetcher))
      .resolves.toMatchObject({ inputId: "input-1", turnId: "turn-1", disposition: "started" })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("/api/agent/sessions/session%2F1/messages")
    expect(init?.headers).toEqual({ "Content-Type": "application/json", "Idempotency-Key": "message-1" })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ delivery: "follow_up", selectedJobPreparation: { jobId: "job/42" } })
    expect(body.content).toEqual([{ type: "text", text: "Prepare a cover letter draft for the selected job." }])
    expect(JSON.stringify(body.content)).not.toContain("job/42")
  })

  it("surfaces an active-turn conflict without retrying as an ordinary message", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 409 }))
    await expect(postSelectedJobPreparation({ sessionId: "s", jobId: "j", clientMessageId: "m" }, fetcher))
      .rejects.toBeInstanceOf(SelectedJobPreparationError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
