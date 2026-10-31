import { describe, expect, it, vi } from "vitest"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"
import { CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL, CHILD_WAIT_SOURCE_RECOVERED_RESULT_SQL, CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL, readChildWaitSourceCallProjection } from "./pg-store-expiry-child-wait-source-proof.js"

describe("registered child-wait source crash proof", () => {
  it("reads only the latest scoped source call and reuses the canonical event projector at the 256-character boundary", async () => {
    const task = { sessionId: "session", id: "task", turnId: "turn", rootTaskId: "root", leaseOwner: "owner",
      attemptCount: 2, leaseExpiresAt: new Date("2026-10-31T00:00:00.000Z"), userId: "user" }
    const rawCallId = "x".repeat(256)
    const query = vi.fn().mockResolvedValue({ rows: [{ toolCallId: rawCallId }] })
    const projection = await readChildWaitSourceCallProjection({ query } as never, task, "continuation")
    const canonical = projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: rawCallId }) as Record<string, unknown>
    expect(rawCallId).toHaveLength(256)
    expect(projection).toEqual({ rawCallId, projectedCallId: canonical.toolCallId })
    expect(projection?.projectedCallId).toBe(rawCallId)
    const phoneProjection = projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: "child-wait-call:415-555-0134" }) as Record<string, unknown>
    expect(phoneProjection.toolCallId).toBe("child-wait-call:[REDACTED_PHONE]")
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[1]).toEqual([task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner,
      task.attemptCount, task.leaseExpiresAt, task.userId, "continuation"])
    expect(CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL).toContain('ORDER BY latestStep."attempt" DESC, latestStep."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 1')
    expect(CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL).toContain('wait."consumedAt" IS NOT NULL')
    expect(CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6')
    expect(CHILD_WAIT_SOURCE_CALL_PROJECTION_SQL).toContain('LIMIT 2')
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expectSqlBindings(sql, values)
  }, 15_000)

  it("fails closed when the source-call pre-read is missing, duplicated, or outside the raw-ID bounds", async () => {
    const task = { sessionId: "session", id: "task", turnId: "turn", rootTaskId: "root", leaseOwner: "owner",
      attemptCount: 2, leaseExpiresAt: new Date("2026-10-31T00:00:00.000Z"), userId: "user" }
    for (const rows of [[], [{ toolCallId: "x" }, { toolCallId: "x" }], [{ toolCallId: "x".repeat(257) }], [{ toolCallId: " x" }]]) {
      await expect(readChildWaitSourceCallProjection({ query: vi.fn().mockResolvedValue({ rows }) } as never, task, "continuation"))
        .resolves.toBeNull()
    }
  })

  it("requires the exact started call and its unique causal start events, with no result or extra lifecycle", () => {
    const sql = CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL.replace(/\s+/g, " ")
    expect(sql).toContain(`sourceCall."status" = 'started'`)
    expect(sql).toContain(`sourceCall."revision" = 0`)
    expect(sql).toContain(`sourceResult."id" IS NULL`)
    expect(sql).toContain(`sourceCall."id" = 'task:' || owner."id" || ':item:tool-call:'`)
    expect(sql).toContain(`sourceCall."content" = jsonb_build_object('toolCallId'`)
    expect(sql).toContain(`sourceItemStarted."type" = 'item.started' AND sourceItemStarted."actor" = 'subagent'`)
    expect(sql).toContain(`sourceCallStarted."type" = 'tool_call.started' AND sourceCallStarted."actor" = 'subagent'`)
    expect(sql).toContain(`sourceCallStarted."causationId" = sourceItemStarted."id"`)
    expect(sql).toContain(`sourceCallStarted."sequence" > sourceItemStarted."sequence"`)
    expect(sql).toContain(`sourceCallStarted."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:'`)
    expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceExtra`)
    expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM "agent_items" AS sourceResultAny`)
    expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM "agent_events" AS sourceResultEvent`)
    expect(sql).toContain(`wait."status" <> 'timed_out' OR wait."result"->'outcome'->>'deadlineAt' <= to_char(clock_timestamp() AT TIME ZONE 'UTC'`)
  })

  it("requires private provenance, exact resolved source output, and one ordered completion chain", () => {
    const sql = CHILD_WAIT_SOURCE_RECOVERED_RESULT_SQL.replace(/\s+/g, " ")
    expect(sql).toContain("sourceCall.\"status\" = 'completed' AND sourceCall.\"revision\" = 1")
    expect(sql).toContain(`sourceCall."content"->'input' = jsonb_build_object('idempotencyKey', wait."idempotencyKey"`)
    expect(sql).toContain(`sourceWaitCallAny."content"->>'toolName' = 'wait_subagents') = 1`)
    expect(sql).toContain(`sourceCallAny."content"->>'toolCallId' = sourceCall."content"->>'toolCallId') = 1`)
    expect(sql).toContain(`sourceResultAny."content"->>'toolCallId' = sourceCall."content"->>'toolCallId') = 1`)
    expect(sql).toContain("sourceResult.\"content\" = jsonb_build_object('toolCallId'")
    expect(sql).toContain(`sourceResult."id" = 'task:' || owner."id" || ':item:tool-result:source-wait-recovery:' || encode(sha256(`)
    expect(sql).toContain(`sourceCall."content"->>'toolCallId' = $11::text`)
    expect(sql).toContain(`sourceCallCompleted."payload"->'content'->>'toolCallId' = $12::text`)
    expect(sql).toContain("'output', wait.\"result\"->'outcome'")
    expect(sql).toContain("'child-wait-source-lifecycle.v1'")
    expect(sql).toContain("wait.\"result\"->'sourceLifecycleRecovery'->>'attempt' = source.\"attempt\"::text")
    expect(sql).toContain("wait.\"result\"->'sourceLifecycleRecovery'->>'stepId' = source.\"id\"")
    expect(sql).toContain("sourceResultCompleted.\"causationId\" = sourceResultStarted.\"id\"")
    expect(sql).toContain("sourcePrior.\"id\" = sourceItemStarted.\"causationId\"")
    expect(sql).toContain("sourcePrior.\"idempotencyKey\" = 'task:' || owner.\"id\" || ':event:model-usage:' || source.\"id\"")
    expect(sql).toContain("sourcePrior.\"sequence\" < sourceItemStarted.\"sequence\"")
    expect(sql).toContain("= 6")
  })
})

function expectSqlBindings(sql: string, values: readonly unknown[]): void {
  const indices = [...new Set(Array.from(sql.matchAll(/\$(\d+)/g), match => Number(match[1])))].sort((a, b) => a - b)
  expect(indices).toEqual(Array.from({ length: values.length }, (_, index) => index + 1))
}
