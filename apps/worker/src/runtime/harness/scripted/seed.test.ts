import assert from "node:assert/strict"

import { modelFinal } from "./adapters/model.js"
import { createHarness, createTurn } from "./contracts/helpers.js"
import { createSeededRandom, resolveHarnessSeed, stableJson } from "./seed.js"
import { registerScriptedTest } from "./test-compat.js"

await registerScriptedTest("HARNESS_SEED produces a repeatable random sequence", async () => {
  const first = createSeededRandom(resolveHarnessSeed("42"))
  const second = createSeededRandom(resolveHarnessSeed("42"))
  assert.deepEqual([first.next(), first.next(), first.integer(1000)], [second.next(), second.next(), second.integer(1000)])
  assert.equal(stableJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}')
  assert.throws(() => resolveHarnessSeed("-1"), TypeError)

  const traces: string[] = []
  for (let run = 0; run < 5; run += 1) {
    const harness = createHarness("deterministic-five-runs", 42, "deterministic-session")
    await harness.runTurn(createTurn([modelFinal(0, "same output")]))
    traces.push(stableJson(harness.trace()))
  }
  assert.equal(new Set(traces).size, 1)
})
