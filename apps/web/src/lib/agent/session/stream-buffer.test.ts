import { describe, expect, it } from "vitest"

import { BoundedStreamBuffer, type StreamFrame } from "./stream-buffer"

function overflow(droppedCount: number): StreamFrame {
  return { kind: "durable", body: `overflow:${droppedCount}` }
}

describe("BoundedStreamBuffer", () => {
  it("drops transient frames and emits an overflow signal", async () => {
    const buffer = new BoundedStreamBuffer(overflow, 2)
    expect(buffer.push({ kind: "transient", body: "delta-1" }).accepted).toBe(true)
    expect(buffer.push({ kind: "transient", body: "delta-2" }).accepted).toBe(true)
    const result = buffer.push({ kind: "transient", body: "delta-3" })
    expect(result).toMatchObject({ accepted: false, droppedTransient: true, requiresSnapshot: false })
    const controller = new AbortController()
    await expect(buffer.next(controller.signal)).resolves.toMatchObject({ kind: "durable", body: "overflow:1" })
    await expect(buffer.next(controller.signal)).resolves.toMatchObject({ body: "delta-2" })
  })

  it("keeps durable frames ahead of transient frames when making room", async () => {
    const buffer = new BoundedStreamBuffer(overflow, 2)
    buffer.push({ kind: "transient", body: "delta" })
    buffer.push({ kind: "durable", body: "event-1" })
    expect(buffer.push({ kind: "durable", body: "event-2" })).toMatchObject({ accepted: true })
    const controller = new AbortController()
    await expect(buffer.next(controller.signal)).resolves.toMatchObject({ body: "event-1" })
    await expect(buffer.next(controller.signal)).resolves.toMatchObject({ kind: "durable", body: "overflow:1" })
    await expect(buffer.next(controller.signal)).resolves.toMatchObject({ body: "event-2" })
  })

  it("signals that a durable-only full buffer must reconnect from the durable source", () => {
    const buffer = new BoundedStreamBuffer(overflow, 2)
    buffer.push({ kind: "durable", body: "event-1" })
    buffer.push({ kind: "durable", body: "event-2" })
    expect(buffer.push({ kind: "durable", body: "event-3" })).toMatchObject({ accepted: false, requiresSnapshot: true })
  })
})
