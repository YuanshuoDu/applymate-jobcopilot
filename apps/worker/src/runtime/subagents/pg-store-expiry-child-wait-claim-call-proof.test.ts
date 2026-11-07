import { describe, expect, it } from "vitest"
import {
  childWaitContinuationKeyMatchesSafeProjection,
  CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL,
  CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL, CHILD_WAIT_CALL_LIFECYCLE_SQL, CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL,
  CHILD_WAIT_SOURCE_PROJECTED_COMPLETION_SQL, isCanonicalChildWaitOutcome,
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

describe("claim terminal settlement event descendants", () => {
  it("only exempts the exact writer-bound step completion after its claim result", () => {
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain("proof.value->'stepToolChain'->>'stepCompletedEventId'")
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain("resultExtra.\"causationId\" = proof.value->>'resultCompletedEventId'")
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain("ordered.\"sequence\" <= ordered.\"previousSequence\"")
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain("modelDone.\"causationId\" = modelStart.\"id\"")
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain("stepDone.\"payload\" = jsonb_build_object('stepId'")
  })

  it("keeps the exported diagnostic components in the production SQL assembly", () => {
    expect(CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL).toContain(CHILD_WAIT_SOURCE_PROJECTED_COMPLETION_SQL)
    expect(CHILD_WAIT_CALL_LIFECYCLE_SQL).toContain(CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL)
  })
})

function matchingSqlCloseParen(sql: string, openIndex: number): number {
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let index = openIndex; index < sql.length; index += 1) {
    const character = sql[index]
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) { index += 1; continue }
        quote = null
      }
      continue
    }
    if (character === "'" || character === '"') { quote = character; continue }
    if (character === "(") depth += 1
    if (character === ")" && --depth === 0) return index
  }
  return -1
}

describe("historical source proof SQL scope", () => {
  it("keeps the source result binding inside the projected proof EXISTS", () => {
    const sql = CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL
    const binding = sql.indexOf("boundSourceResult.\"id\" = proof.value->'sourceWait'->>'sourceResultItemId'")
    const alias = sql.lastIndexOf("AS proof(value)", binding)
    const exists = sql.lastIndexOf("EXISTS (", alias)
    const close = matchingSqlCloseParen(sql, exists + "EXISTS ".length)

    expect(binding).toBeGreaterThan(0)
    expect(alias).toBeGreaterThan(0)
    expect(exists).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(binding)
  })
})
describe("canonical historical child-wait outcome", () => {
  function fixture() {
    const deadlineAt = new Date("2026-11-06T10:00:00.123Z")
    const wait = { id: "wait-1", status: "ready", mode: "any", targetTaskIds: ["child-1", "child-2"],
      matchedTaskIds: ["child-1"], deadlineAt, resolvedAt: new Date("2026-11-06T09:59:00.000Z") }
    const outcome = { waitId: wait.id, status: wait.status, taskIds: wait.targetTaskIds, deadlineAt: deadlineAt.toISOString(),
      matchedTaskIds: wait.matchedTaskIds, tasks: [
        { taskId: "child-1", status: "completed", role: "writer", result: null, failureReason: null },
        { taskId: "child-2", status: "running", role: "analyst", result: null, failureReason: null },
      ] }
    return { wait, outcome }
  }

  it("accepts a canonical ready snapshot without consulting mutable current child rows", () => {
    const { wait, outcome } = fixture()
    const currentChildStatuses = ["completed", "queued"]
    expect(isCanonicalChildWaitOutcome(wait, outcome)).toBe(true)
    expect(currentChildStatuses).not.toEqual(outcome.tasks.map(task => task.status))
  })

  it.each([
    ["unknown task status", (wait: Record<string, unknown>, outcome: Record<string, unknown>) => {
      (outcome.tasks as Record<string, unknown>[])[0]!.status = "unknown"
    }],
    ["empty ready match", (_wait: Record<string, unknown>, outcome: Record<string, unknown>) => { outcome.matchedTaskIds = [] }],
    ["misbound match", (_wait: Record<string, unknown>, outcome: Record<string, unknown>) => { outcome.matchedTaskIds = ["other-child"] }],
    ["invalid mode", (wait: Record<string, unknown>) => { wait.mode = "first" }],
    ["noncanonical offset deadline", (_wait: Record<string, unknown>, outcome: Record<string, unknown>) => {
      outcome.deadlineAt = "2026-11-06T10:00:00.123+00:00"
    }],
    ["altered deadline", (_wait: Record<string, unknown>, outcome: Record<string, unknown>) => {
      outcome.deadlineAt = "2026-11-06T10:00:00.124Z"
    }],
    ["timeout before deadline", (wait: Record<string, unknown>, outcome: Record<string, unknown>) => {
      wait.status = outcome.status = "timed_out"
      wait.resolvedAt = new Date("2026-11-06T10:00:00.122Z")
    }],
    ["ready at or after deadline", (wait: Record<string, unknown>) => { wait.resolvedAt = wait.deadlineAt }],
  ] as const)("rejects %s", (_label, corrupt) => {
    const { wait, outcome } = fixture()
    corrupt(wait, outcome)
    expect(isCanonicalChildWaitOutcome(wait, outcome)).toBe(false)
  })

  it("requires every target for ready all-mode and a terminal snapshot for each match", () => {
    const { wait, outcome } = fixture()
    wait.mode = "all"
    expect(isCanonicalChildWaitOutcome(wait, outcome)).toBe(false)
    ;(outcome.tasks[1] as Record<string, unknown>).status = "failed"
    outcome.matchedTaskIds = ["child-1", "child-2"]
    wait.matchedTaskIds = ["child-1", "child-2"]
    expect(isCanonicalChildWaitOutcome(wait, outcome)).toBe(true)
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
  it("requires a repeated raw call ID to match the selected item, source step, and attempt", () => {
    const source = { rawCallId: "same-source-call", callItemId: "source-call-attempt-1", sourceStepId: "source-step-attempt-1", sourceAttempt: 1 }
    const decoys = [
      { ...source, callItemId: "other-call-attempt-1" },
      { ...source, sourceStepId: "other-step-attempt-1" },
      { ...source, callItemId: "source-call-attempt-2", sourceStepId: "source-step-attempt-2", sourceAttempt: 2 },
    ]
    expect(decoys.every(candidate => candidate.rawCallId === source.rawCallId)).toBe(true)
    expect(decoys.map(candidate => candidate.callItemId === source.callItemId
      && candidate.sourceStepId === source.sourceStepId && candidate.sourceAttempt === source.sourceAttempt)).toEqual([false, false, false])
    const sql = CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL.replace(/\s+/g, " ")
    expect(sql).not.toContain('jsonb_array_length(wait."targetTaskIds")')
    expect(sql).not.toContain('jsonb_array_elements_text(wait."matchedTaskIds")')
    expect(sql).toContain('proof.value->>\'rawCallId\' = callItem."content"->>\'toolCallId\' AND started."correlationId" = proof.value->>\'rawCallId\'')
    expect(sql).toContain('proof.value->>\'callItemId\' = callItem."id" AND proof.value->>\'stepId\' = callItem."stepId"')
    expect(sql).toContain('proof.value->>\'attempt\' = callStep."attempt"::text AND callStep."attempt" BETWEEN 1 AND owner."attemptCount"')
  })

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
    expect(sql).toContain("proof.value->>'resultStartedEventId' IS NOT NULL")
    expect(sql).toContain("proof.value->>'resultCompletedEventId' IS NOT NULL")
    expect(sql).toContain("resultExtra.\"causationId\" IN (proof.value->>'resultStartedEventId', proof.value->>'resultCompletedEventId')")
    expect(sql).toContain("resultExtra.\"id\" <> proof.value->>'resultCompletedEventId'")
    expect(sql).toContain("settled.\"causationId\" = itemCompleted.\"id\"")
    expect(sql).not.toContain("tool-call-recovered:")
    expect(sql).not.toContain("tool-recovered:")
    expect(sql).toContain("settled.\"type\" = 'tool_call.completed'")
    expect(sql).toContain("settled.\"type\" = 'tool_call.failed'")
    expect(sql).toContain("jsonb_array_elements(CASE WHEN jsonb_typeof($13::jsonb) = 'array' THEN $13::jsonb ELSE '[]'::jsonb END)")
    expect(sql).toContain("proof.value->>'startEventId' = started.\"id\"")
    expect(sql).toContain("proof.value->>'rawCallId' = callItem.\"content\"->>'toolCallId'")
    expect(sql).toContain("proof.value->>'projectedCallId' IS NOT NULL")
    expect(sql).toContain("proof.value->>'callItemId' = callItem.\"id\"")
    expect(sql).toContain("proof.value->>'stepId' = callItem.\"stepId\"")
    expect(sql).toContain("proof.value->>'attempt' = callStep.\"attempt\"::text")
    expect(sql).toContain("itemCompleted.\"payload\" = jsonb_build_object('itemId', callItem.\"id\", 'status', 'completed'")
    expect(sql).toContain("'idempotencyKey', '[REDACTED]'")
    expect(sql).toContain("'toolCallId', proof.value->>'projectedCallId'")
    expect(sql).toContain("jsonb_array_length(CASE WHEN jsonb_typeof(callItem.\"content\"->'input'->'taskIds') = 'array'")
    expect(sql).toContain("terminal.\"type\" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) = 1")
    expect(sql).toContain("extra.\"id\" NOT IN (itemStarted.\"id\", started.\"id\", itemCompleted.\"id\", settled.\"id\")")
  })
})
