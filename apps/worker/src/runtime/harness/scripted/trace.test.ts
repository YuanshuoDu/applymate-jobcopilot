import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { modelFinal } from "./adapters/model.js"
import { createHarness, createTurn } from "./contracts/helpers.js"
import { registerScriptedTest } from "./test-compat.js"
import { writeHarnessTrace } from "./trace.js"

await registerScriptedTest("trace writer persists the deterministic contract schema", async () => {
  const harness = createHarness("trace-test")
  await harness.runTurn(createTurn([modelFinal(0, "trace complete")]))
  const directory = await mkdtemp(join(tmpdir(), "harness-trace-"))
  const path = await writeHarnessTrace(harness.trace(), directory)
  const content = await readFile(path, "utf8")
  assert.match(content, /agent-harness\.v2\.scripted-trace/)
  assert.match(content, /trace complete/)
  const artifactPath = await writeHarnessTrace(harness.trace())
  assert.match(artifactPath, /__artifacts__[\\/]harness-contract-42\.json$/)
})
