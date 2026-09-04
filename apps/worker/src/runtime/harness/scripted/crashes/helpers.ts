import assert from "node:assert/strict"

import { replayHarnessTrace } from "../replay.js"
import type { ScriptedHarness, ScriptedTurnResult } from "../runner.js"
import type { FaultPoint } from "../types.js"
import { assertLedgerEvidence } from "../contracts/helpers.js"

export function assertCrashReplay(harness: ScriptedHarness, result: ScriptedTurnResult, fault: FaultPoint, status: ScriptedTurnResult["status"], errorCode: string | null = null): void {
  const trace = harness.trace()
  assert.equal(result.status, status)
  assert.equal(result.errorCode, errorCode)
  assert.equal(trace.finalState.status, status)
  assert.equal(trace.finalState.externalWrites, 0)
  const injected = trace.events.find(event => event.type === "fault.injected")
  assert.ok(injected)
  assert.equal(injected.payload !== null && typeof injected.payload === "object" && !Array.isArray(injected.payload) ? injected.payload.fault : undefined, fault)
  assert.equal(trace.seed, harness.seed)
  assert.deepEqual(replayHarnessTrace(trace), trace.finalState)
  assertLedgerEvidence(harness.ledger)
}
