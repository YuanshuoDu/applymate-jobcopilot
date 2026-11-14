import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
import { filterHistoricalWaitClaimCollisions, historicalWaitClaimDigestSql, historicalWaitClaimProofBundle,
  historicalWaitSourceItemSql, MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES } from "./pg-store-expiry-historical-wait-claim-collision.js"

const digest = createHash("sha256").update("api_key=[REDACTED]").digest("hex")
const sourceKeyDigest = (value: string) => createHash("sha256").update(value).digest("hex")
function source(waitId: string, key: string): TerminalCallProjection {
  return { startEventId: `source-start-${waitId}`, rawCallId: `source-call-${waitId}`, projectedCallId: `source-call-${waitId}`,
    callItemId: `source-item-${waitId}`, stepId: `source-step-${waitId}`, attempt: 1, sourceWait: {
      waitId, sourceStepId: `source-step-${waitId}`, sourceAttempt: 1, sourceCallItemId: `source-item-${waitId}`,
      sourceCallId: `source-call-${waitId}`, projectedSourceCallId: `source-call-${waitId}`, sourceResultItemId: `source-result-${waitId}`,
      sourceKeyDigest: sourceKeyDigest(key), sourceLifecycleRecoveryOwnerDigest: null, claimKeyDigest: null,
      sourceKind: "normal_waiting", deadlineAt: "2026-11-07T10:00:00.000Z", status: "ready", mode: "any",
      targetTaskIds: [`target-${waitId}`], matchedTaskIds: [`target-${waitId}`], timeoutMs: 30_000,
    }, sourceStepPrefix: { marker: waitId } as never }
}
function claim(wait: TerminalCallProjection): TerminalCallProjection {
  const waitId = wait.sourceWait.waitId
  return { startEventId: `claim-start-${waitId}`, rawCallId: `claim-call-${waitId}`, projectedCallId: `claim-call-${waitId}`,
    callItemId: `claim-item-${waitId}`, stepId: `claim-step-${waitId}`, attempt: 1,
    sourceWait: { ...wait.sourceWait, claimKeyDigest: digest }, sourceStepPrefix: wait.sourceStepPrefix,
    resultItemId: `claim-result-${waitId}`, resultStartedEventId: `result-start-${waitId}`,
    resultCompletedEventId: `result-completed-${waitId}`, stepCompletedEventId: `step-completed-${waitId}`,
    stepToolChain: { nextEventId: `next-${waitId}`, calls: [{ callItemId: `claim-item-${waitId}` }] } }
}
function candidate(projection: TerminalCallProjection, waitId = projection.sourceWait.waitId) {
  return { callItemId: projection.callItemId, stepId: projection.stepId, attempt: projection.attempt,
    claimKeyDigest: projection.sourceWait.claimKeyDigest, resultItemCount: 1,
    resultItemId: projection.resultItemId, resultWaitId: waitId }
}

describe("historical wait claim collision proof", () => {
  it("treats missing, oversized, or whitespace-padded raw keys as unknown candidates", () => {
    const sql = historicalWaitClaimDigestSql("candidate")
    expect(sql).toContain("char_length(candidate.\"content\"->'input'->>'idempotencyKey') BETWEEN 1 AND 256")
    expect(sql).toContain("btrim(candidate.\"content\"->'input'->>'idempotencyKey') = candidate.\"content\"->'input'->>'idempotencyKey'")
    expect(sql).toMatch(/END$/)
  })

  it("excludes only the canonical same-step source item with exact receipt input", () => {
    const sql = historicalWaitSourceItemSql("candidate")
    expect(sql).toContain("candidate.\"id\" = 'task:' || owner.\"id\"")
    expect(sql).toContain("candidate.\"content\"->'input' = jsonb_build_object('idempotencyKey', sourceWait.\"idempotencyKey\"")
    expect(sql).toContain("sourceWait.\"userId\" = session.\"userId\"")
    expect(sql).toContain("sourceStep.\"attempt\" = owner.\"attemptCount\"")
    expect(sql).toContain("sameStepWait.\"stepId\" = sourceStep.\"id\") = 1")
    expect(sql).toContain("sameStepCall.\"content\"->>'toolName' = 'wait_subagents') = 1")
  })

  it("accepts two independently bound waits with distinct raw key digests but one projected key digest", () => {
    const firstSource = source("wait-1", "api_key=first-secret")
    const secondSource = source("wait-2", "api_key=second-secret")
    const firstClaim = claim(firstSource), secondClaim = claim(secondSource)
    expect(firstSource.sourceWait.sourceKeyDigest).not.toBe(secondSource.sourceWait.sourceKeyDigest)
    expect(firstClaim.sourceWait.claimKeyDigest).toBe(secondClaim.sourceWait.claimKeyDigest)
    const projections = [firstSource, firstClaim, secondSource, secondClaim]
    expect(filterHistoricalWaitClaimCollisions([candidate(firstClaim), candidate(secondClaim)], projections)).toEqual(projections)
  })

  it("preserves all independently bound projections at the 16-candidate limit", () => {
    const projections = Array.from({ length: MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES }, (_, index) => {
      const sourceWait = source(`wait-${index}`, `api_key=independent-${index}`)
      return [sourceWait, claim(sourceWait)]
    }).flat()
    const candidates = projections.filter(row => row.sourceWait.claimKeyDigest !== null).map(row => candidate(row))

    expect(candidates).toHaveLength(MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES)
    expect(filterHistoricalWaitClaimCollisions(candidates, projections)).toEqual(projections)
  })

  it("fails closed for same-wait duplicates, missing results, unknown wait ids, and unprojected candidates", () => {
    const firstSource = source("wait-1", "api_key=first-secret"), secondSource = source("wait-2", "api_key=second-secret")
    const firstClaim = claim(firstSource), secondClaim = claim(secondSource)
    const projections = [firstSource, firstClaim, secondSource, secondClaim]
    expect(filterHistoricalWaitClaimCollisions([candidate(firstClaim), candidate(firstClaim)], projections)).toEqual([firstSource, secondSource])
    expect(filterHistoricalWaitClaimCollisions([{ ...candidate(firstClaim), resultItemCount: 0, resultItemId: null, resultWaitId: null },
      candidate(secondClaim)], projections)).toEqual([firstSource, secondSource])
    expect(filterHistoricalWaitClaimCollisions([{ ...candidate(firstClaim), claimKeyDigest: null }, candidate(secondClaim)], projections))
      .toEqual([firstSource, secondSource])
    expect(filterHistoricalWaitClaimCollisions([candidate(firstClaim), candidate(secondClaim, "unknown-wait")], projections))
      .toEqual([firstSource, secondSource])
    expect(filterHistoricalWaitClaimCollisions([candidate(firstClaim), candidate(secondClaim),
      { ...candidate(secondClaim), callItemId: "unprojected-claim" }], projections)).toEqual([firstSource, secondSource])
  })

  it("rejects the seventeenth candidate and serializes peer proofs once with only bounded references", () => {
    const projections = Array.from({ length: MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES }, (_, index) => {
      const sourceWait = source(`wait-${index}`, `api_key=secret-${index}`)
      return [sourceWait, claim(sourceWait)]
    }).flat()
    const claims = projections.filter(row => row.sourceWait.claimKeyDigest !== null)
    const overflow = [...claims.map(row => candidate(row)), { ...candidate(claims[0]!), callItemId: "overflow" }]
    expect(filterHistoricalWaitClaimCollisions(overflow, projections)).toEqual(projections.filter(row => row.sourceWait.claimKeyDigest === null))
    const bundle = historicalWaitClaimProofBundle(projections)
    expect(bundle.claimCollisionProofs).toHaveLength(MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES)
    const claimRows = (bundle.projections as Record<string, unknown>[]).filter(row => row.claimCollisionPeerIds)
    expect(claimRows).toHaveLength(MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES)
    expect(claimRows.every(row => (row.claimCollisionPeerIds as string[]).length === MAX_HISTORICAL_WAIT_CLAIM_CANDIDATES - 1)).toBe(true)
    expect(bundle.claimCollisionProofs).toEqual(claimRows)
    expect(JSON.stringify(bundle)).not.toContain("api_key=secret-")
    expect(JSON.stringify(bundle).length).toBeLessThan(300_000)
  })
})
