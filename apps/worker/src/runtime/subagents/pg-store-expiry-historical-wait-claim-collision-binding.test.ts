import { describe, expect, it } from "vitest"
import { historicalWaitClaimCollisionBindingSql, historicalWaitExactClaimCountSql } from "./pg-store-expiry-historical-wait-claim-collision-binding.js"

const compact = historicalWaitClaimCollisionBindingSql('EXISTS (SELECT 1 FROM "agent_wait_conditions" AS boundWait WHERE proof.value IS NOT NULL)')

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

describe("historical wait claim collision final binding", () => {
  it("blocks NULL-digest candidates and caps candidate census at the seventeenth sentinel", () => {
    expect(compact).toContain("WHEN CASE WHEN jsonb_typeof(claimCandidate.\"content\"->'input')")
    expect(compact).toContain("IS NULL THEN TRUE ELSE NOT")
    expect(compact).toContain("COUNT(*) = jsonb_array_length(CASE WHEN jsonb_typeof(proof.value->'claimCollisionPeerIds')")
    expect(compact).toContain("COUNT(*) <= 16")
    expect(compact).toContain('LIMIT 17')
    expect(compact).toContain('candidateStep."attempt" = owner."attemptCount"')
    expect(compact).toContain('claimCandidate."sessionId" = owner."sessionId"')
    expect(balanced(compact)).toBe(true)
  })

  it("revalidates complete redacted peer call/result events against their exact wait", () => {
    expect(compact).toContain("callCompleted.\"payload\" = jsonb_build_object('itemId', callItem.\"id\", 'status', 'completed'")
    expect(compact).toContain("'idempotencyKey', '[REDACTED]'")
    expect(compact).toContain("'taskIds', CASE WHEN jsonb_array_length")
    expect(compact).toContain('callCompleted."sequence" > started."sequence"')
    expect(compact).toContain("resultCompleted.\"payload\" = jsonb_build_object('itemId', claimResult.\"id\", 'status', 'completed'")
    expect(compact).toContain("claimResult.\"content\"->'output'->>'waitId' = " + 'peerWait."id"')
    expect(compact).toContain("peerWait.\"id\" <> boundWait.\"id\"")
    expect(balanced(compact)).toBe(true)
  })

  it("binds each continuation result to its resolved wait outcome, separately from the source receipt", () => {
    expect(compact).toContain('claimResult."content"->\'output\' = boundWait."result"->\'outcome\'')
    expect(compact).toContain('claimResult."content"->\'output\' = peerWait."result"->\'outcome\'')
    expect(compact).not.toContain('claimResult."content"->\'output\' = sourceResult."content"->\'output\'')
    expect(compact).toContain('sourceResult."id" = proof.value->\'sourceWait\'->>\'sourceResultItemId\'')
  })

  it("requires a one-to-one peer reference and proof set and fails closed on missing or duplicate proof", () => {
    expect(compact).toContain("COUNT(DISTINCT ref.value #>> '{}')")
    expect(compact).toContain("COUNT(DISTINCT currentProof.value->>'callItemId')")
    expect(compact).toContain("currentProof.value = proof.value")
    expect(compact).toContain("NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(proofBundle.\"claimCollisionProofs\")")
    expect(compact).toContain("JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(proof.value->'claimCollisionPeerIds')")
    expect(compact).toContain("WHERE duplicate.value->>'callItemId' = peer.value->>'callItemId') = 1")
    expect(compact).toContain("AND claimCandidate.\"id\" <> callItem.\"id\"")
    expect(compact).toContain("claimResult.\"content\"->'output'->>'waitId' = " + 'boundWait."id"')
    expect(balanced(compact)).toBe(true)
  })

  it("counts exact wait claims across digests and excludes only the bound source item", () => {
    const exactWait = historicalWaitExactClaimCountSql()
    expect(exactWait).toContain('sameWaitStep."attempt" = owner."attemptCount"')
    expect(exactWait).toContain('sameWaitClaim."sessionId" = owner."sessionId"')
    expect(exactWait).toContain('sameWaitResult."content"->\'output\'->>\'waitId\' = boundWait."id"')
    expect(exactWait).toContain('sameWaitClaim."id" <> boundSourceCall."id"')
    expect(exactWait).toContain('MIN(sameWaitClaim."id") = callItem."id"')
    expect(exactWait).toContain('COUNT(*) = 1')
    expect(exactWait).not.toContain("claimKeyDigest")
    expect(balanced(exactWait)).toBe(true)
  })

  it("bounds full candidate proofs to 17 rows and rejects overflow or any unproven candidate", () => {
    const boundedStart = compact.indexOf("(SELECT COUNT(*) <= 16")
    const boundedEnd = compact.indexOf("AS boundedCall)", boundedStart) + "AS boundedCall)".length
    expect(boundedStart).toBeGreaterThanOrEqual(0)
    expect(boundedEnd).toBeGreaterThan(boundedStart)
    const bounded = compact.slice(boundedStart, boundedEnd)
    expect(bounded).toContain("COUNT(*) <= 16")
    expect(bounded).toContain("COUNT(*) FILTER (WHERE boundedCall.\"id\" <> callItem.\"id\"")
    expect(bounded).toContain("AND NOT (SELECT COUNT(*) = 1")
    expect(bounded).toContain("FROM (SELECT candidate.\"id\"")
    expect(bounded).toContain("candidateStep.\"attempt\" = owner.\"attemptCount\"")
    expect(bounded).toContain("ORDER BY candidate.\"id\" LIMIT 17) AS boundedCall")
    expect(bounded).toContain("candidate.\"id\" = 'task:' || owner.\"id\"")
    expect(bounded).toContain("candidate.\"content\"->'input' = jsonb_build_object('idempotencyKey', sourceWait.\"idempotencyKey\"")
    expect(bounded).toContain("peerWait.\"id\" <> boundWait.\"id\"")
    expect(bounded).toContain("claimResult.\"content\"->'output'->>'waitId' = peerWait.\"id\"")
    expect(balanced(bounded)).toBe(true)
  })
})
