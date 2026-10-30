import { describe, expect, it } from "vitest"
import { buildRootTaskHistoryCrossSessionWindow } from "./root-task-history-source-window.js"

const baseInput = {
  currentSessionId: "current-session", userId: "owner", currentTurnId: "current-turn", currentStartXid8: "90",
  scheduledCriteria: null, objectiveDigest: "objective-digest", semanticsVersion: 2,
  canonicalOrigin: '["user","none"]', limit: 64,
}

describe("root task history cross-session source window", () => {
  it("keeps tenant, objective, origin, receipt, xid and graph eligibility ahead of the raw page limit", () => {
    const result = buildRootTaskHistoryCrossSessionWindow(baseInput)
    const sql = result.sql
    const count = sql.indexOf('COUNT(*) OVER (PARTITION BY event."id")')
    const limit = sql.indexOf("LIMIT $9")

    expect(count).toBeGreaterThan(0)
    expect(limit).toBeGreaterThan(count)
    for (const predicate of [
      'event."sessionId" <> $1', 'source_session."userId" = $2',
      '(witness.payload->>\'xid8\')::numeric < $4::numeric',
      'turn."objectiveDigest" = $6', 'turn."objectiveIndexSemanticsVersion" = $7',
      "jsonb_build_array(turn.\"source\", 'none') = $8::jsonb",
      'dispatch."payload" = jsonb_build_object', 'terminal_dispatch."payload" = jsonb_build_object',
      'turn."userId" = $2', 'event."taskId" = turn."rootTaskId"', 'task."status" = turn."status"',
      "NOT (turn.\"input\" ? 'selectedJobPreparation')", "AND event.\"type\" = CASE turn.\"status\"",
    ]) {
      expect(sql.indexOf(predicate)).toBeGreaterThanOrEqual(0)
      expect(sql.indexOf(predicate)).toBeLessThan(limit)
    }
    expect(sql).toContain("'interactive_discovery_shortlist'")
    expect(sql).toContain("ARRAY['kind','version']")
    expect(result.values).toEqual(["current-session", "owner", "current-turn", "90", null,
      "objective-digest", 2, '["user","none"]', 64])
  })

  it("counts every eligible witness before applying a strict total-order cursor", () => {
    const cursor = { xid8: "87", turnId: "turn-7", terminalEventId: "event-7", witnessEventId: "witness-7" }
    const result = buildRootTaskHistoryCrossSessionWindow({ ...baseInput, afterCursor: cursor })
    const sql = result.sql
    const count = sql.indexOf('COUNT(*) OVER (PARTITION BY event."id")')
    const page = sql.indexOf("page AS MATERIALIZED")
    const cursorFilter = sql.indexOf('WHERE ((candidate."terminalWitnessXid8")::numeric,')
    const limit = sql.indexOf("LIMIT $9")

    expect(page).toBeGreaterThan(count)
    expect(cursorFilter).toBeGreaterThan(page)
    expect(limit).toBeGreaterThan(cursorFilter)
    expect(sql).toContain('candidate."turnId" COLLATE "C", candidate."terminalEventId" COLLATE "C",')
    expect(sql).toContain('candidate."terminalWitnessEventId" COLLATE "C")')
    expect(sql).toContain('< ($10::numeric, $11::text COLLATE "C", $12::text COLLATE "C", $13::text COLLATE "C")')
    expect(sql).toContain('candidate."terminalEventId" COLLATE "C" DESC, candidate."terminalWitnessEventId" COLLATE "C" DESC')
    expect(sql).toContain('page."terminalEventId" COLLATE "C" ASC, page."terminalWitnessEventId" COLLATE "C" ASC')
    expect(sql).toContain('ORDER BY "isPageWatermark" ASC, ("terminalWitnessXid8")::numeric DESC NULLS LAST,')
    expect(sql).toContain('"terminalEventId" COLLATE "C" DESC NULLS LAST,')
    expect(sql).toContain('"terminalWitnessEventId" COLLATE "C" DESC NULLS LAST')
    expect(result.values).toEqual(["current-session", "owner", "current-turn", "90", null,
      "objective-digest", 2, '["user","none"]', 64, "87", "turn-7", "event-7", "witness-7"])
  })

  it("caps raw rows at 64 and emits a separate watermark sentinel, including for an empty page", () => {
    const result = buildRootTaskHistoryCrossSessionWindow({ ...baseInput, limit: 128 })
    const sql = result.sql
    const limit = sql.indexOf("LIMIT $9")
    const sentinel = sql.indexOf('TRUE AS "isPageWatermark"')

    expect(result.values[8]).toBe(64)
    expect(limit).toBeGreaterThan(0)
    expect(sentinel).toBeGreaterThan(limit)
    expect(sql).toContain('FALSE AS "isPageWatermark"')
    expect(sql).toContain('(SELECT COUNT(*)::integer FROM page) AS "pageRawRowCount"')
    expect(sql).toContain('(SELECT "terminalWitnessXid8" FROM watermark) AS "pageCursorXid8"')
    expect(sql).toContain('(SELECT "turnId" FROM watermark) AS "pageCursorTurnId"')
    expect(sql).toContain('(SELECT "terminalEventId" FROM watermark) AS "pageCursorTerminalEventId"')
    expect(sql).toContain('(SELECT "terminalWitnessEventId" FROM watermark) AS "pageCursorWitnessEventId"')
  })
})
