import { describe, expect, it } from "vitest"
import { buildRootTaskHistoryCrossSessionWindow } from "./root-task-history-source-window.js"

describe("root task history cross-session source window", () => {
  it("filters tenant, objective, origin, receipt, and xid before the bounded limit", () => {
    const result = buildRootTaskHistoryCrossSessionWindow({
      currentSessionId: "current-session", userId: "owner", currentTurnId: "current-turn", currentStartXid8: "90",
      scheduledCriteria: null, objectiveDigest: "objective-digest", semanticsVersion: 2,
      canonicalOrigin: '["user","none"]', limit: 64,
    })
    const sql = result.sql
    const limit = sql.indexOf("LIMIT $9")

    expect(limit).toBeGreaterThan(0)
    for (const predicate of [
      'event."sessionId" <> $1', 'source_session."userId" = $2',
      '(witness.payload->>\'xid8\')::numeric < $4::numeric',
      'turn."objectiveDigest" = $6', 'turn."objectiveIndexSemanticsVersion" = $7',
      "jsonb_build_array(turn.\"source\", 'none') = $8::jsonb",
      'dispatch."payload" = jsonb_build_object',
    ]) expect(sql.indexOf(predicate)).toBeGreaterThanOrEqual(0)
    for (const predicate of ['turn."objectiveDigest" = $6', 'turn."objectiveIndexSemanticsVersion" = $7',
      "jsonb_build_array(turn.\"source\", 'none') = $8::jsonb", 'dispatch."payload" = jsonb_build_object',
      'terminal_dispatch."payload" = jsonb_build_object', 'turn."userId" = $2',
      'event."taskId" = turn."rootTaskId"', 'task."status" = turn."status"',
      "NOT (turn.\"input\" ? 'selectedJobPreparation')", "AND event.\"type\" = CASE turn.\"status\""]) {
      expect(sql.indexOf(predicate)).toBeLessThan(limit)
    }
    expect(sql).toContain("'interactive_discovery_shortlist'")
    expect(sql).toContain("ARRAY['kind','version']")
    expect(result.values).toEqual(["current-session", "owner", "current-turn", "90", null, "objective-digest", 2, '["user","none"]', 64])
  })
})
