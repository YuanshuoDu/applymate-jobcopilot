import assert from "node:assert/strict"

import { registerScriptedTest } from "./test-compat.js"
import type { HarnessEvent, JsonValue } from "./types.js"

await registerScriptedTest("scripted protocol types accept JSON event payloads", () => {
  const payload: JsonValue = { scenario: "job-search", count: 1 }
  const event: HarnessEvent = { id: "event-1", sequence: 1, type: "test", at: "2026-01-01T00:00:00.000Z", payload }
  assert.equal(event.payload, payload)
})
