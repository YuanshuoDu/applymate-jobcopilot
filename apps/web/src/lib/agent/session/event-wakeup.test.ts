import { describe, expect, it, vi } from "vitest"

import {
  createDurablePollWakeup,
  startAgentEventWakeup,
  type AgentEventPubSubRedis,
} from "./event-wakeup"

function redis() {
  let messageListener: ((channel: string, message: string) => void) | undefined
  let errorListener: ((error: unknown) => void) | undefined
  const connection = {
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 0),
    onMessage: vi.fn((listener: (channel: string, message: string) => void) => { messageListener = listener }),
    onError: vi.fn((listener: (error: unknown) => void) => { errorListener = listener }),
    removeMessageListener: vi.fn(),
    removeErrorListener: vi.fn(),
    disconnect: vi.fn(),
  } satisfies AgentEventPubSubRedis
  return {
    connection,
    emit(channel: string, message: string) { messageListener?.(channel, message) },
    fail(error: unknown) { errorListener?.(error) },
  }
}

describe("agent event Pub/Sub wakeup", () => {
  it("notifies only for the exact session channel and ignores message contents", async () => {
    const controller = new AbortController()
    const wakeup = createDurablePollWakeup()
    const pubsub = redis()
    const running = startAgentEventWakeup("session_1", () => pubsub.connection, wakeup, controller.signal)

    await Promise.resolve()
    pubsub.emit("agent:session:other:events", JSON.stringify({ sequence: "99" }))
    const notWoken = await Promise.race([
      wakeup.wait(5, controller.signal).then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 10)),
    ])
    expect(notWoken).toBe(false)

    pubsub.emit("agent:session:session_1:events", "not-json")
    await expect(wakeup.wait(100, controller.signal)).resolves.toBeUndefined()
    controller.abort()
    await running
  })

  it("unsubscribes, removes listeners, and disconnects on abort", async () => {
    const controller = new AbortController()
    const wakeup = createDurablePollWakeup()
    const pubsub = redis()
    const running = startAgentEventWakeup("session_1", () => pubsub.connection, wakeup, controller.signal)

    await expect(pubsub.connection.subscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    controller.abort()
    await running

    expect(pubsub.connection.unsubscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(pubsub.connection.removeMessageListener).toHaveBeenCalledTimes(1)
    expect(pubsub.connection.removeErrorListener).toHaveBeenCalledTimes(1)
    expect(pubsub.connection.disconnect).toHaveBeenCalledTimes(1)
  })

  it("returns cleanly when Redis subscription fails", async () => {
    const controller = new AbortController()
    const wakeup = createDurablePollWakeup()
    const pubsub = redis()
    pubsub.connection.subscribe.mockRejectedValueOnce(new Error("redis unavailable"))

    await expect(startAgentEventWakeup("session_1", () => pubsub.connection, wakeup, controller.signal)).resolves.toBeUndefined()
    expect(pubsub.connection.unsubscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(pubsub.connection.disconnect).toHaveBeenCalledTimes(1)
  })

  it("cleans up when abort races a pending Redis subscription", async () => {
    const controller = new AbortController()
    const wakeup = createDurablePollWakeup()
    const pubsub = redis()
    pubsub.connection.subscribe.mockImplementation(() => new Promise<number>(() => undefined))

    const running = startAgentEventWakeup("session_1", () => pubsub.connection, wakeup, controller.signal)
    await expect(pubsub.connection.subscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    controller.abort()
    await expect(running).resolves.toBeUndefined()

    expect(pubsub.connection.unsubscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(pubsub.connection.disconnect).toHaveBeenCalledTimes(1)
  })
})
