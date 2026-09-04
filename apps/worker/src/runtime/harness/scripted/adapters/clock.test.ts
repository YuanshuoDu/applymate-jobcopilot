import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { scriptedClock } from "./clock.js"

await registerScriptedTest("scripted clock advances from a fixed instant", () => {
  const clock = scriptedClock({ start: "2026-01-01T00:00:00.000Z", advance: 25 })
  assert.equal(clock.nowIso(), "2026-01-01T00:00:00.000Z")
  clock.advance()
  assert.equal(clock.nowIso(), "2026-01-01T00:00:00.025Z")
})
