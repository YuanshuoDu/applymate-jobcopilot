import { describe, expect, it } from "vitest"
import { CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL } from "./pg-store-expiry-historical-wait-binding.js"
import { CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL, CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL,
  HISTORICAL_SOURCE_STEP_BINDING_SQL, HISTORICAL_SOURCE_WAIT_HANDOFF_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"
import { HISTORICAL_SOURCE_STEP_PREFIX_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"

const sql = CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL.replace(/\s+/g, " ")
const unparenthesizedJsonExtractionAfterConcat = /\|\|\s*(?:[a-z_][\w]*\.)?(?:"[^"]+"|[a-z_][\w]*)(?:\s*->>?\s*(?:'[^']+'|"[^"]+"))+/i
function sqlDiagnosis(value: string): { balance: number; quoteAt: number | null } {
  let depth = 0, quote: "'" | '"' | null = null
  let quoteAt: number | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) { if (char === quote) { if (value[index + 1] === quote) { index += 1; continue } quote = null; quoteAt = null } continue }
    if (char === "'" || char === '"') { quote = char; quoteAt = index; continue }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return { balance: depth, quoteAt }
  }
  return { balance: quote ? Number.NaN : depth, quoteAt }
}

describe("final historical wait receipt binding", () => {
  it("keeps the final binding and both source proof fragments syntactically balanced", () => {
    const binding = sqlDiagnosis(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL)
    const events = sqlDiagnosis(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL)
    const receipt = sqlDiagnosis(CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL)
    const prefix = sqlDiagnosis(HISTORICAL_SOURCE_STEP_PREFIX_SQL)
    const handoff = sqlDiagnosis(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL)
    const stepBinding = sqlDiagnosis(HISTORICAL_SOURCE_STEP_BINDING_SQL)
    expect(events.balance, `event quote ${events.quoteAt}: ${JSON.stringify(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL.slice(Math.max(0, (events.quoteAt ?? 0) - 20), (events.quoteAt ?? 0) + 80))}`).toBe(0)
    expect(binding.balance, `binding quote ${binding.quoteAt}`).toBe(0)
    expect(receipt.balance).toBe(0)
    expect(prefix.balance).toBe(0)
    expect(handoff.balance).toBe(0)
    expect(stepBinding.balance).toBe(0)
  })
  it("revalidates the same receipt under the current owner and tenant fence", () => {
    expect(sql).toContain("boundWait.\"id\" = proof.value->'sourceWait'->>'waitId'")
    expect(sql).toContain("boundWait.\"userId\" = session.\"userId\"")
    expect(sql).toContain("boundWait.\"sessionId\" = owner.\"sessionId\"")
    expect(sql).toContain("boundWait.\"turnId\" = owner.\"turnId\"")
    expect(sql).toContain("owner.\"rootTaskId\" = $4")
    expect(sql).toContain("owner.\"leaseOwner\" = $5")
    expect(sql).toContain("owner.\"attemptCount\" = $6")
    expect(sql).toContain("owner.\"leaseExpiresAt\" = $7")
    expect(sql).toContain("session.\"userId\" = $8")
    expect(sql).toContain("sameStepWait.\"stepId\" = boundWait.\"stepId\") = 1")
  })

  it("binds the canonical deadline, request, outcome, targets, and lifecycle sidecar", () => {
    expect(sql).toContain("boundWait.\"deadlineAt\" IS NOT NULL AND boundWait.\"resolvedAt\" IS NOT NULL")
    expect(sql).toContain("boundWait.\"targetTaskIds\" = proof.value->'sourceWait'->'targetTaskIds'")
    expect(sql).toContain("boundWait.\"matchedTaskIds\" = proof.value->'sourceWait'->'matchedTaskIds'")
    expect(sql).toContain("boundWait.\"result\"->'request' = jsonb_build_object")
    expect(sql).toContain("boundWait.\"result\"->'outcome'->>'deadlineAt' = proof.value->'sourceWait'->>'deadlineAt'")
    expect(sql).toContain("boundWait.\"result\"->'sourceLifecycleRecovery'")
    expect(sql).toContain("boundSourceResult.\"content\" = jsonb_build_object")
  })

  it("rechecks the validated recovered marker owner digest against the current receipt", () => {
    expect(CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL).toContain("sourceLifecycleRecoveryOwnerDigest")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL).toContain("encode(sha256(convert_to(")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL).toContain("boundWait.\"result\"->'sourceLifecycleRecovery'->>'ownerId'")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL).toContain("proof.value->'sourceWait'->'sourceLifecycleRecoveryOwnerDigest' = 'null'::jsonb")
    expect(sql).toContain("sourceLifecycleRecoveryOwnerDigest")
  })

  it("uses safe array fallbacks and rejects malformed JSON without unsafe array operations", () => {
    expect(sql).toContain("CASE WHEN jsonb_typeof(boundWait.\"targetTaskIds\") = 'array'")
    expect(sql).toContain("CASE WHEN jsonb_typeof(boundWait.\"matchedTaskIds\") = 'array'")
    expect(sql).toContain("CASE WHEN jsonb_typeof(boundWait.\"result\"->'outcome'->'tasks') = 'array'")
    expect(sql).not.toContain('jsonb_array_length(boundWait."targetTaskIds")')
    expect(sql).not.toContain('jsonb_array_elements(boundWait."matchedTaskIds")')
  })

  it("requires the unique completed continuation claim for this receipt and current attempt", () => {
    expect(sql).toContain("callStep.\"attempt\" = owner.\"attemptCount\"")
    expect(sql).toContain("callStep.\"status\" = 'completed'")
    expect(sql).toContain("nextStep.\"attempt\" = owner.\"attemptCount\"")
    expect(sql).toContain("claimCandidate.\"type\" = 'tool_call'")
    expect(sql).toContain("claimCandidate.\"content\"->>'toolName' = 'wait_subagents'")
    expect(sql).toContain("= proof.value->'sourceWait'->>'claimKeyDigest') = 1")
  })

  it("binds top-level identity to the current call while source identity stays in sourceWait", () => {
    const branchStart = sql.indexOf("AND CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb THEN")
    const branchEnd = sql.indexOf("AND boundSourceResult.\"status\"", branchStart)
    const identityBranch = sql.slice(branchStart, branchEnd)
    expect(sql).toContain("boundSourceCall.\"id\" = proof.value->'sourceWait'->>'sourceCallItemId'")
    expect(sql).toContain("boundSourceCall.\"content\"->>'toolCallId' = proof.value->'sourceWait'->>'sourceCallId'")
    expect(sql).toContain("proof.value->>'callItemId' = callItem.\"id\"")
    expect(sql).toContain("proof.value->>'rawCallId' = callItem.\"content\"->>'toolCallId'")
    expect(sql).toContain("proof.value->>'stepId' = callStep.\"id\"")
    expect(sql).toContain("proof.value->>'attempt' = callStep.\"attempt\"::text")
    expect(identityBranch).toContain("boundSourceCall.\"id\" = proof.value->>'callItemId'")
    expect(identityBranch).toContain("proof.value->>'projectedCallId' = proof.value->'sourceWait'->>'projectedSourceCallId'")
    expect(identityBranch).toContain("ELSE callItem.\"id\" <> boundSourceCall.\"id\" END")
    expect(branchStart).toBeGreaterThanOrEqual(0)
    expect(branchEnd).toBeGreaterThan(branchStart)
  })

  it("parenthesizes JSON text extraction operands after PostgreSQL concatenation", () => {
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
  })

  it("accepts recovered handoff only as source evidence while retaining the complete claim proof", () => {
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain("recovered_wait_handoff.v2")
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain('boundSource."status" = \'waiting_for_tool\'')
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain('sourceStepDone."type" = \'step.completed\'')
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain('scopedItem."stepId" = boundSource."id")')
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain("windowEvent.\"sequence\" BETWEEN")
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain("WITH ORDINALITY AS expected(value, ordinality)")
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain("'ordinal', boundSource.\"ordinal\"")
    expect(HISTORICAL_SOURCE_WAIT_HANDOFF_SQL).toContain("toolCallCount")
    expect(HISTORICAL_SOURCE_STEP_BINDING_SQL).toContain("sourceStepPrefix")
    expect(HISTORICAL_SOURCE_STEP_BINDING_SQL).toContain("sourceStepHandoff")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain(HISTORICAL_SOURCE_STEP_BINDING_SQL)
    expect(sql.match(/CASE WHEN proof\.value \? 'sourceStepPrefix'/g) ?? []).toHaveLength(1)
    expect(sql).toContain("callStep.\"attempt\" = owner.\"attemptCount\"")
    expect(sql).toContain("callStep.\"status\" = 'completed'")
    expect(sql).toContain("= proof.value->'sourceWait'->>'claimKeyDigest') = 1")
  })
})
