import { describe, expect, it, vi } from "vitest"

import { runAdmittedModelStep } from "./admitted-model-step.js"

function writer(events: string[], failStart = false) {
  return { append: vi.fn(async (type: string, _correlationId: string, _itemId: string | null, _payload: unknown, _key: string) => {
    events.push(type)
    if (failStart && type === "model.started") throw new Error("session_pause_requested")
    return `${type}-event`
  }) }
}

describe("admitted model step", () => {
  it("persists start before provider invocation and settles completion afterward", async () => {
    const events: string[] = [], sink = writer(events), result = { text: "answer" }
    const invoke = vi.fn(async () => { events.push("provider"); return result })
    await expect(runAdmittedModelStep({ writer: sink, stepId: "step-1", taskId: "root-1", provider: "fixture", model: "test", invoke })).resolves.toBe(result)
    expect(events).toEqual(["model.started", "provider", "model.completed"])
    expect(sink.append.mock.calls.map(call => call[4])).toEqual(["model-started:step-1", "model-completed:step-1"])
  })

  it("never invokes a provider when the durable start fence is denied", async () => {
    const events: string[] = [], sink = writer(events, true), invoke = vi.fn(), onStartDenied = vi.fn()
    await expect(runAdmittedModelStep({ writer: sink, stepId: "step-1", provider: "fixture", model: "test", invoke, onStartDenied })).rejects.toThrow("session_pause_requested")
    expect(invoke).not.toHaveBeenCalled()
    expect(onStartDenied).toHaveBeenCalledOnce()
    expect(events).toEqual(["model.started"])
  })

  it("writes a failed settlement for a completed provider error", async () => {
    const events: string[] = [], sink = writer(events), failure = Object.assign(new Error("provider"), { code: "provider_unavailable" })
    await expect(runAdmittedModelStep({ writer: sink, stepId: "step-1", provider: "fixture", model: "test", invoke: async () => { throw failure } })).rejects.toBe(failure)
    expect(events).toEqual(["model.started", "model.failed"])
    expect(sink.append.mock.calls[1]?.[3]).toMatchObject({ errorCode: "provider_unavailable" })
  })
})
