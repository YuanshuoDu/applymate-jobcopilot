import { describe, expect, it } from "vitest"
import { historicalSourceStepCallCountBinding, historicalSourceStepContinuationBinding } from "./pg-store-expiry-historical-source-step-continuation-binding.js"
import { CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL } from "./pg-store-expiry-child-wait-claim-call-proof.js"

const path = "proof.value->'sourceStepPrefix'"
const boundedEventIndex = "(CASE WHEN expected.ordinality BETWEEN 2 AND 7 THEN (expected.ordinality - 2)::integer ELSE NULL::integer END)"
function occurrences(sql: string, fragment: string): number { return sql.split(fragment).length - 1 }
function balance(sql: string): number {
  let depth = 0, quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) { if (char === quote) { if (sql[index + 1] === quote) { index += 1; continue } quote = null } continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return depth
  }
  return quote ? Number.NaN : depth
}

describe("historical source step continuation SQL", () => {
  it("rechecks the current-attempt seven-event wait claim and its persisted sole item", () => {
    const sql = historicalSourceStepContinuationBinding(path)
    expect(balance(sql)).toBe(0)
    expect(sql).toContain("continuationPrefix")
    expect(sql).toContain(`WHEN 1 THEN 'task:' || boundSource."taskId" || ':event:' || 'step-started:' ||`)
    expect(sql).toContain(`'child-wait-claim:' || owner."attemptCount"::text`)
    expect(sql).toContain(`successor."attempt" = owner."attemptCount"`)
    expect(sql).toContain(`successor."status" = 'streaming'`)
    expect(sql).toContain(`parentEvent."type" = 'task.started'`)
    expect(sql).toContain(`parentEvent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:turn-started'`)
    expect(sql).toContain(`parentEvent."sequence"::text =`)
    expect(sql).toContain(`parentEvent."sequence" < (SELECT firstEvent."sequence"`)
    expect(sql).toContain(`parentEvent."payload"->>'rootTaskId' = owner."rootTaskId"`)
    expect(sql).toContain(`encode(sha256(convert_to(parentEvent."payload"::text,'UTF8')),'hex')`)
    expect(sql).toContain(`duplicateParent."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:turn-started'`)
    expect(sql).toContain(`THEN to_jsonb(((proof.value->'sourceStepPrefix'->'continuationPrefix')->'parent')->>'id')`)
    expect(sql).not.toContain(`THEN NULL::text`)
    expect(sql).toContain(`continuationItem."content"->'input' = boundSourceCall."content"->'input'`)
    expect(sql).toContain(`continuationItem."status" = 'started' AND continuationItem."revision" = 0`)
    expect(sql).toContain(`continuationItem."status" = 'completed' AND continuationItem."revision" = 1`)
    expect(sql).toContain(`(SELECT COUNT(*) FROM jsonb_object_keys(continuationItem."content")) = 4`)
    expect(sql).toContain(`continuationItem."content"->>'status' = 'completed'`)
    expect(sql).toContain(`continuationItem."content"->'errorCode' = 'null'::jsonb`)
    expect(sql).toContain(`continuationItem."content" ?& ARRAY['toolCallId','toolName','toolVersion','input','status','errorCode']`)
    expect(sql).toContain("->'item'->>'status' = 'completed' AND")
    expect(sql).toContain("->'item'->>'revision' = '1')")
    expect(sql).toContain("->'item'->>'status' = continuationItem.\"status\"")
    expect(sql).toContain("->'item'->>'revision' = continuationItem.\"revision\"::text")
    expect(sql).toContain("terminal.\"itemId\" = 'task:' || boundSource.\"taskId\" || ':item:tool-result:'")
    expect(sql).toContain("terminal.\"correlationId\" = 'task:' || boundSource.\"taskId\" || ':item:tool-result:'")
    expect(sql).toContain(`terminal."idempotencyKey" = ('task:' || boundSource."taskId" || ':event:' || 'tool-finished:' || ((proof.value->'sourceStepPrefix'->'continuationPrefix')->>'callId'))`)
    expect(sql).toContain(`'tool-call-completed:' || ((proof.value->'sourceStepPrefix'->'continuationPrefix')->>'callId') || ':' || ((proof.value->'sourceStepPrefix'->'continuationPrefix')->>'callItemId') || ':1'`)
    expect(sql).toContain("'tool-result-completed:' ||")
    expect(sql).toContain("AS actual ON actual.")
    expect(sql).toContain(`actual."causationId" IS NOT DISTINCT FROM`)
    expect(sql).toContain(`actual."sequence" >`)
    expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM "agent_events" AS terminal`)
    expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra`)
    expect(sql).toContain("tool_call.interrupted")
  })

  it("uses guarded int4 indexes for every prior continuation event lookup", () => {
    const sql = historicalSourceStepContinuationBinding(path)
    expect(sql).toContain("WHERE expected.ordinality BETWEEN 1 AND 7")
    expect(occurrences(sql, boundedEventIndex)).toBe(3)
    expect(occurrences(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL, boundedEventIndex)).toBe(6)
  })

  it("keeps the original call count and admits only the one separately proved continuation call", () => {
    const sql = historicalSourceStepCallCountBinding(path)
    expect(balance(sql)).toBe(0)
    expect(sql).toContain("CASE WHEN jsonb_typeof((proof.value->'sourceStepPrefix'->'continuationPrefix')) = 'object' THEN 1 ELSE 0 END")
    expect(sql).toContain('started."payload" = jsonb_build_object')
    expect(sql).toContain(`ELSE (SELECT MAX(started."sequence")`)
    expect(sql).toContain("toolCallCount")
  })
})
