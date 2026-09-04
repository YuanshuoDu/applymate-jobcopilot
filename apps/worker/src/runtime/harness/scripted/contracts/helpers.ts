import assert from "node:assert/strict"

import { assertLedgerContract, type SideEffectLedger } from "../ledger.js"
import { ScriptedHarness, type ScriptedTurn } from "../runner.js"
import { scriptedModel } from "../adapters/model.js"
import type { ScriptedModelStep } from "../types.js"

export function createHarness(scenario: string, seed = 42, sessionId = `session-${scenario}`): ScriptedHarness {
  return new ScriptedHarness({ scenario, seed, sessionId })
}

export function createTurn(steps: readonly ScriptedModelStep[], overrides: Omit<Partial<ScriptedTurn>, "model"> = {}): ScriptedTurn {
  return { goal: overrides.goal ?? "scripted job-search task", model: scriptedModel({ steps }), ...overrides }
}

export function assertContractResult(harness: ScriptedHarness, result: { status: string; errorCode: string | null; state: { sessionId: string; turnId: string | null; eventSequence: number; externalWrites: number } }, status: string, errorCode: string | null = null): void {
  assert.equal(result.status, status)
  assert.equal(result.errorCode, errorCode)
  assert.equal(result.state.sessionId, harness.trace().finalState.sessionId)
  assert.ok(result.state.turnId)
  assert.ok(result.state.eventSequence > 0)
  assert.equal(result.state.externalWrites, 0)
  assertLedgerEvidence(harness.ledger)
}

export function assertLedgerEvidence(ledger: SideEffectLedger): void {
  const entries = ledger.snapshot()
  assertLedgerContract(ledger)
  for (const type of ["tool.execution", "approval.consume", "artifact.write", "event.publish", "turn.complete"] as const) {
    const matching = entries.filter(entry => entry.type === type)
    assert.ok(matching.length >= 1, `ledger count for ${type} must be positive`)
    assert.notEqual(matching[0]?.payload, undefined, `ledger payload for ${type} is required`)
  }
  assert.equal(entries.at(-1)?.type, "turn.complete")
}
