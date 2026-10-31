import { describe, expect, it } from "vitest"
import {
  childWaitContinuationKeyMatchesSafeProjection,
  CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL,
  CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL, CHILD_WAIT_CALL_LIFECYCLE_SQL, CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL,
} from "./pg-store-expiry-child-wait-claim-call-proof.js"

describe("child-wait continuation key projection", () => {
  it.each([
    ["phone-shaped key", "child-wait:415-555-0134:attempt:1", "child-wait:[REDACTED_PHONE]:attempt:1"],
    ["bearer key", "child-wait:Bearer abcdefghijklmnop:attempt:1", "child-wait:Bearer [REDACTED]:attempt:1"],
    ["API key assignment", "child-wait:api_key=abcdefghijk123456:attempt:1", "child-wait:api_key=[REDACTED]"],
    ["ordinary key", "child-wait:opaque-key:attempt:1", "child-wait:opaque-key:attempt:1"],
  ])("matches only the safe projection for %s", (_label, source, projected) => {
    expect(childWaitContinuationKeyMatchesSafeProjection(source, projected)).toBe(true)
    expect(childWaitContinuationKeyMatchesSafeProjection(source, `${projected}:wrong`)).toBe(false)
  })

  it("fails closed for absent, malformed, or out-of-scope key values", () => {
    expect(childWaitContinuationKeyMatchesSafeProjection(null, "child-wait:key")).toBe(false)
    expect(childWaitContinuationKeyMatchesSafeProjection(" child-wait:key", "child-wait:key")).toBe(false)
    expect(childWaitContinuationKeyMatchesSafeProjection("child-wait:key", "other-wait:key")).toBe(false)
  })

  it("selects metadata only for the one owner-scoped source step and exact continuation item", () => {
    const sql = CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL.replace(/\s+/g, " ")
    expect(sql).toContain('sourceCall."stepId" = latest_wait."stepId"')
    expect(sql).toContain('sourceCall."taskId" = $2')
    expect(sql).toContain('sourceCall."sessionId" = $1 AND sourceCall."turnId" = $3')
    expect(sql).toContain('claimedCall."stepId" = $10')
    expect(sql).toContain('claimedCall."sessionId" = $1 AND claimedCall."turnId" = $3')
    expect(sql).toContain('claimedCall."taskId" = $2')
    expect(sql).toContain("':attempt:' || $6::text")
    expect(sql).not.toContain("':attempt:' || latest_wait.\"attempt\"::text")
    expect(sql).toContain('CASE WHEN COUNT(*) = 1 THEN MAX(')
  })
})

describe("completed child-wait claim call without item.completed", () => {
  it("accepts only the exact completed row cut with unique call, claim lifecycle, and no result/terminal event", () => {
    const sql = CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL.replace(/\s+/g, " ")
    expect(sql).toContain(`claimedCall."status" = 'completed' AND claimedCall."revision" = 1`)
    expect(sql).toContain(`claimedCall."content" = jsonb_build_object('toolCallId', started."correlationId"`)
    expect(sql).toContain(`stepCall."stepId" = continuation."id" AND stepCall."type" = 'tool_call') = 1`)
    expect(sql).toContain(`(itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id") AND itemCompleted."type" = 'item.completed'`)
    expect(sql).toContain(`extra."correlationId" = claimedCall."id" OR extra."correlationId" = started."correlationId"`)
    expect(sql).toContain(`extra."id" <> itemStarted."id" AND extra."id" <> started."id"`)
    expect(sql).toContain(`terminal."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted', 'item.failed', 'item.interrupted')`)
    expect(sql).toContain(`result."stepId" = continuation."id" AND result."type" = 'tool_result'`)
    expect(sql).toContain(`resultEvent."itemId" = 'task:' || owner."id" || ':item:tool-result:'`)
  })

  it("preserves the original started and exact completed-event lifecycle gates", () => {
    const sql = CHILD_WAIT_CALL_LIFECYCLE_SQL.replace(/\s+/g, " ")
    expect(sql).toContain(`claimedCall."status" = 'started' AND (SELECT COUNT(*) FROM "agent_items" AS stepCall`)
    expect(sql).toContain(`stepCall."stepId" = continuation."id" AND stepCall."type" = 'tool_call') = 1`)
    expect(sql).toContain(`extra."correlationId" = started."correlationId" OR extra."causationId" = itemStarted."id" OR extra."causationId" = started."id"`)
    expect(sql).toContain(`extra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-call-completed:'`)
    expect(sql).toContain(`extra."idempotencyKey" = 'task:' || owner."id" || ':event:tool-finished:'`)
    expect(sql).toContain(`claimedCall."status" = 'completed' AND EXISTS`)
    expect(sql).toContain(`itemCompleted."actor" = 'subagent' AND itemCompleted."correlationId" = claimedCall."id"`)
    expect(sql).toContain(`itemCompleted."causationId" = started."id"`)
    expect(sql).toContain(`started."sequence" < itemCompleted."sequence"`)
    expect(sql).toContain(`itemCompleted."payload" = jsonb_build_object('itemId', claimedCall."id", 'status', 'completed', 'content', claimedCall."content")`)
    expect(sql).toContain(`(itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id") AND itemCompleted."type" = 'item.completed') = 1`)
    expect(sql).toContain(CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL.replace(/\s+/g, " ").trim())
  })
})

describe("child-wait terminal settlement", () => {
  it("keeps unrelated calls on the existing path and requires the complete causal lifecycle for waits", () => {
    const sql = CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL.replace(/\s+/g, " ")
    expect(sql).toContain("started.\"payload\"->>'toolName' = 'wait_subagents'")
    expect(sql).toContain("settled.\"payload\"->>'toolName' = 'wait_subagents'")
    expect(sql).toContain("hint.\"content\"->>'toolName' = 'wait_subagents'")
    expect(sql).toContain(":event:child-wait-claim:")
    expect(sql).toContain("started.\"causationId\" = itemStarted.\"id\"")
    expect(sql).toContain("callStep.\"taskId\" = callItem.\"taskId\"")
    expect(sql).toContain("itemStarted.\"correlationId\" = callStep.\"id\"")
    expect(sql).toContain("itemStarted.\"sequence\" < started.\"sequence\"")
    expect(sql).toContain("started.\"sequence\" < itemCompleted.\"sequence\"")
    expect(sql).toContain("itemCompleted.\"sequence\" < settled.\"sequence\"")
    expect(sql).toContain("itemStarted.\"causationId\" IS NULL AND NOT EXISTS")
    expect(sql).toContain("prior.\"id\" = itemStarted.\"causationId\"")
    expect(sql).toContain("itemCompleted.\"causationId\" = started.\"id\"")
    expect(sql).toContain("extra.\"correlationId\" = callItem.\"id\"")
    expect(sql).toContain("settled.\"causationId\" = itemCompleted.\"id\"")
    expect(sql).not.toContain("tool-call-recovered:")
    expect(sql).not.toContain("tool-recovered:")
    expect(sql).toContain("settled.\"type\" = 'tool_call.completed'")
    expect(sql).toContain("settled.\"type\" = 'tool_call.failed'")
    expect(sql).toContain("terminal.\"type\" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) = 1")
    expect(sql).toContain("extra.\"id\" NOT IN (itemStarted.\"id\", started.\"id\", itemCompleted.\"id\", settled.\"id\")")
  })
})
