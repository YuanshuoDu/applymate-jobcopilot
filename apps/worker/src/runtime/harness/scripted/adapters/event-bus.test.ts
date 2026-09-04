import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { scriptedEventBus } from "./event-bus.js"

await registerScriptedTest("scripted event bus deduplicates and replays events", () => {
  const bus = scriptedEventBus()
  const event = { id: "event-1", sequence: 1, type: "test", at: "2026-01-01T00:00:00.000Z", payload: { value: 1 } }
  assert.equal(bus.publish(event), true)
  assert.equal(bus.publish(event), false)
  assert.equal(bus.replay(0).length, 1)
  bus.disconnect()
  assert.equal(bus.publish({ ...event, id: "event-2", sequence: 2 }), false)
  bus.reconnect()
  assert.equal(bus.isConnected(), true)
})
