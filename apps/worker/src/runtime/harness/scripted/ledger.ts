import assert from "node:assert/strict"

import type { JsonValue } from "./types.js"

export const LEDGER_TYPES = ["tool.execution", "approval.consume", "artifact.write", "event.publish", "turn.complete"] as const
export type LedgerType = typeof LEDGER_TYPES[number]

export type LedgerEntry = {
  readonly sequence: number
  readonly type: LedgerType
  readonly key: string
  readonly at: string
  readonly payload: JsonValue
}

export class SideEffectLedger {
  private readonly entries: LedgerEntry[] = []
  private readonly keys = new Map<string, LedgerEntry>()

  constructor(private readonly now: () => string) {}

  record(type: LedgerType, key: string, payload: JsonValue): LedgerEntry {
    const existing = this.keys.get(`${type}:${key}`)
    if (existing) return existing
    const entry = { sequence: this.entries.length + 1, type, key, at: this.now(), payload: clone(payload) }
    this.entries.push(entry)
    this.keys.set(`${type}:${key}`, entry)
    return entry
  }

  snapshot(): readonly LedgerEntry[] {
    return this.entries.map(entry => ({ ...entry, payload: clone(entry.payload) }))
  }
}

export function assertLedgerContract(ledger: SideEffectLedger): void {
  const entries = ledger.snapshot()
  const types = new Set(entries.map(entry => entry.type))
  for (const type of LEDGER_TYPES) assert.ok(types.has(type), `ledger is missing ${type}`)
  assert.deepEqual(entries.map(entry => entry.sequence), entries.map((_, index) => index + 1))
  assert.ok(entries.every(entry => entry.key.length > 0 && entry.at.endsWith("Z")))
  assert.equal(entries.at(-1)?.type, "turn.complete")
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
