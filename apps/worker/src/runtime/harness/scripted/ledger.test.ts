import assert from "node:assert/strict"

import { assertLedgerContract, SideEffectLedger } from "./ledger.js"
import { registerScriptedTest } from "./test-compat.js"

await registerScriptedTest("side effect ledger is ordered and idempotent", () => {
  const ledger = new SideEffectLedger(() => "2026-01-01T00:00:00.000Z")
  ledger.record("tool.execution", "tool-1", { ok: true })
  ledger.record("tool.execution", "tool-1", { ok: false })
  ledger.record("approval.consume", "approval-1", { decision: "not_required" })
  ledger.record("artifact.write", "artifact-1", { ok: true })
  ledger.record("event.publish", "event-1", { type: "test" })
  ledger.record("turn.complete", "turn-1", { status: "completed" })
  assert.equal(ledger.snapshot().length, 5)
  assert.deepEqual(ledger.snapshot()[0]?.payload, { ok: true })
  assertLedgerContract(ledger)
})
