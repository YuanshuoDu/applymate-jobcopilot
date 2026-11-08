import { describe, expect, it } from "vitest"
import { CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL, buildHistoricalWaitBindingSql } from "./pg-store-expiry-historical-wait-binding-core.js"

function balanced(sql: string): boolean {
  let depth = 0, quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) {
      if (char === quote && sql[index + 1] === quote) { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return false
  }
  return depth === 0 && quote === null
}

describe("historical wait core binding", () => {
  it("keeps owner, tenant, source receipt, source events, and exact first-later claim checks", () => {
    const sql = CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL
    expect(sql).toContain('owner."leaseOwner" = $5')
    expect(sql).toContain('owner."attemptCount" = $6')
    expect(sql).toContain('owner."leaseExpiresAt" = $7')
    expect(sql).toContain('boundWait."userId" = session."userId"')
    expect(sql).toContain('sourceItemStarted."type" = \'item.started\'')
    expect(sql).toContain('boundSourceResult."status" = \'completed\'')
    expect(sql).toContain('callStep."id" = (SELECT nextStep."id"')
    expect(sql).toContain('nextStep."ordinal" > boundSource."ordinal"')
    expect(sql).not.toContain("claimCollisionPeerIds")
    expect(sql).not.toContain("claimCandidate")
    expect(balanced(sql)).toBe(true)
  })

  it("inserts final predicates inside the source EXISTS scope", () => {
    const sql = buildHistoricalWaitBindingSql('proof.value->>\'callItemId\' = callItem."id"')
    expect(sql).toContain('AND proof.value->>\'callItemId\' = callItem."id"\n)')
    expect(balanced(sql)).toBe(true)
  })

  it("rejects scalar claim content before enumerating object keys", () => {
    const sql = CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL.replace(/\s+/g, " ")
    expect(sql).toContain('CASE WHEN jsonb_typeof(callItem."content") = \'object\' THEN (SELECT COUNT(*) FROM jsonb_object_keys(callItem."content")) = 6 ELSE FALSE END')
  })

  it("matches only canonical positive JSON int4 source attempts without casting untrusted text", () => {
    const sql = CHILD_WAIT_HISTORICAL_WAIT_CORE_BINDING_SQL
    expect(sql).toContain("jsonb_typeof(proof.value->'sourceWait'->'sourceAttempt') = 'number'")
    expect(sql).toContain("proof.value->'sourceWait'->>'sourceAttempt' ~ '^[1-9][0-9]{0,9}$'")
    expect(sql).toContain("('2147483647'::text COLLATE \"C\")")
    expect(sql).toContain("THEN boundSource.\"attempt\"::text = proof.value->'sourceWait'->>'sourceAttempt' ELSE FALSE END")
    expect(sql).not.toContain("proof.value->'sourceWait'->>'sourceAttempt')::integer")

    const attemptPattern = sql.match(/proof\.value->'sourceWait'->>'sourceAttempt' ~ '([^']+)'/)?.[1]
    expect(attemptPattern).toBe("^[1-9][0-9]{0,9}$")
    const matchesAttempt = (jsonType: string, value: string, persistedAttempt: number) => jsonType === "number"
      && new RegExp(attemptPattern!).test(value)
      && (value.length < 10 || value <= "2147483647")
      && value === String(persistedAttempt)
    expect(matchesAttempt("number", "4", 4)).toBe(true)
    expect(matchesAttempt("number", "2147483647", 2147483647)).toBe(true)
    expect(matchesAttempt("string", "4", 4)).toBe(false)
    expect(matchesAttempt("number", "2147483648", 2147483647)).toBe(false)
    expect(matchesAttempt("number", "99999999999", 2147483647)).toBe(false)
    expect(matchesAttempt("number", "not-an-integer", 4)).toBe(false)
  })
})
