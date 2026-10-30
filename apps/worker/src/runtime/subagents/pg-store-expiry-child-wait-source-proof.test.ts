import { describe, expect, it } from "vitest"
import { CHILD_WAIT_SOURCE_STARTED_NO_RESULT_SQL } from "./pg-store-expiry-child-wait-source-proof.js"

describe("registered child-wait source crash proof", () => {
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
})
