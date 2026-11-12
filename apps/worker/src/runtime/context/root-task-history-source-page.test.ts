import { describe, expect, it } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { rootTaskHistoryObjectiveDigest, type RootTaskHistoryFence, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import {
  buildRootTaskHistorySameSessionPageWindow, parseRootTaskHistoryPage, rootTaskHistoryCursorAdvanced, scanRootTaskHistoryPages,
  validateRootTaskHistoryCandidate, validateRootTaskHistoryFootprintCandidate,
  type RootTaskHistoryPage, type RootTaskHistorySourceCursor,
} from "./root-task-history-source-page.js"

const targetInput = { goal: "Find roles", successCriteria: ["Use saved filters"], intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const footprintFence: RootTaskHistoryFence = {
  currentStartSequence: 20n, searchFootprintStartWitness: { eventId: "current-footprint-start", xid8: "10" },
  searchFootprintOrigin: '["user","objective_task_graph_execution",1]',
  objectiveDigest: rootTaskHistoryObjectiveDigest(targetInput, { goal: "Find roles", successCriteria: ["Use saved filters"] })!,
}
const footprintInput: RootTaskHistoryFenceInput = {
  lease: { turnId: "current-turn", sessionId: "current-session", userId: "user-a", ownerId: "worker", leaseVersion: 1,
    leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
  rootTaskId: "current-root", rootAttemptCount: 1, stepId: "current-step", now: new Date(2_000),
  crossSessionRootTaskHistoryEnabled: true, searchFootprintReadAllowed: true,
}

function objectiveFootprintCandidate(input: unknown = targetInput, turnSource = "user") {
  return {
    turnId: "source-turn", sessionId: "source-session", userId: "user-a", rootTaskId: "source-root", turnStatus: "failed",
    turnSource, sourceSessionUserId: "user-a", sourceSessionStatus: "running", input,
    taskId: "source-root", taskTurnId: "source-turn", taskRootTaskId: "source-root", parentTaskId: null,
    taskRole: "orchestrator", taskType: "root", taskStatus: "failed", goal: "Find roles", successCriteria: ["Use saved filters"],
    startTurnId: "source-turn", startTaskId: "source-root", startItemId: null, startSequence: "1", startType: "turn.started",
    startActor: "orchestrator", startCorrelationId: "source-turn", startIdempotencyKey: "turn:source-turn:event:turn-started",
    startPayload: { taskId: "source-root", rootTaskId: "source-root" }, startEventCount: 1,
    terminalTurnId: "source-turn", terminalTaskId: "source-root", terminalItemId: null, terminalSequence: "3",
    terminalType: "turn.failed", terminalActor: "orchestrator", terminalCorrelationId: "source-turn",
    terminalIdempotencyKey: "turn:source-turn:event:turn-failed:task_failed",
    terminalPayload: { turnId: "source-turn", taskId: "source-root", errorCode: "task_failed", finalItemId: null }, terminalEventCount: 1,
    terminalEventId: "terminal-event", terminalCreatedAt: new Date("2026-10-07T11:00:00.000Z"),
    terminalWitnessEventId: "source-terminal-witness",
    terminalWitnessXid8: "8", terminalWitnessCount: 1,
  }
}

describe("root task history source paging", () => {
  it("validates objective-v1 candidates only in the independent footprint channel", () => {
    const matching = objectiveFootprintCandidate()
    expect(validateRootTaskHistoryFootprintCandidate(matching, footprintInput, footprintFence)).toMatchObject({
      sessionId: "source-session", turnId: "source-turn", rootTaskId: "source-root", terminalXid8: "8",
    })
    expect(validateRootTaskHistoryCandidate(matching, footprintInput,
      { ...footprintFence, currentOrigin: '["user","none"]' })).toBeUndefined()
    for (const candidate of [
      objectiveFootprintCandidate({ ...targetInput, intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, version: 2 } }),
      objectiveFootprintCandidate({ ...targetInput, intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, extra: true } }),
      objectiveFootprintCandidate({ ...targetInput, input: { ...targetInput, intent: { kind: "interactive_discovery_shortlist", version: 1 } } }),
      objectiveFootprintCandidate(targetInput, "automation"),
    ]) expect(validateRootTaskHistoryFootprintCandidate(candidate, footprintInput, footprintFence)).toBeUndefined()
  })

  it("strips the independently carried watermark metadata before candidate validation", () => {
    const rows = [{
      turnId: "turn-1", isPageWatermark: false, pageRawRowCount: 1, pageSentinelCount: 1, pageServerEncoding: "UTF8",
      pageCursorSequence: "9", pageCursorXid8: null, pageCursorTurnId: "turn-1",
      pageCursorTerminalEventId: "event-1", pageCursorWitnessEventId: null,
    }]
    const page = parseRootTaskHistoryPage(rows, false)
    expect(page).toMatchObject({ rawRowCount: 1, cursor: {
      sequence: "9", turnId: "turn-1", terminalEventId: "event-1",
    } })
    expect(page?.rows[0]).toEqual({ turnId: "turn-1" })
  })

  it("rejects duplicate or missing watermark sentinels", () => {
    const sentinel = {
      isPageWatermark: true, pageRawRowCount: 0, pageSentinelCount: 1, pageServerEncoding: "UTF8",
      pageCursorSequence: null, pageCursorXid8: null, pageCursorTurnId: null,
      pageCursorTerminalEventId: null, pageCursorWitnessEventId: null,
    }
    expect(parseRootTaskHistoryPage([sentinel, { ...sentinel }], false)).toBeUndefined()
    expect(parseRootTaskHistoryPage([], false)).toBeUndefined()
  })

  it("keeps Unicode cursor IDs when the PostgreSQL C ordering uses UTF-8", () => {
    const rows = [{
      isPageWatermark: false, pageRawRowCount: 1, pageSentinelCount: 1, pageServerEncoding: "UTF8",
      pageCursorSequence: "9", pageCursorXid8: null, pageCursorTurnId: "𐀀",
      pageCursorTerminalEventId: "event-1", pageCursorWitnessEventId: null,
    }]
    expect(parseRootTaskHistoryPage(rows, false)?.cursor).toMatchObject({ turnId: "𐀀" })
  })

  it("fails closed when database encoding cannot match the UTF-8 cursor comparator", () => {
    const rows = [{
      isPageWatermark: true, pageRawRowCount: 0, pageSentinelCount: 1, pageServerEncoding: "LATIN1",
      pageCursorSequence: null, pageCursorXid8: null, pageCursorTurnId: null,
      pageCursorTerminalEventId: null, pageCursorWitnessEventId: null,
    }]
    expect(parseRootTaskHistoryPage(rows, false)).toBeUndefined()
  })

  it("advances after an all-filtered raw page and reaches a later valid candidate", async () => {
    const cursors: Array<RootTaskHistorySourceCursor | undefined> = []
    const first: RootTaskHistorySourceCursor = { sequence: "100", turnId: "turn-100", terminalEventId: "event-100" }
    const second: RootTaskHistorySourceCursor = { sequence: "36", turnId: "turn-36", terminalEventId: "event-36" }
    let calls = 0
    const candidates = await scanRootTaskHistoryPages({
      crossSession: false,
      readPage: async (cursor, limit): Promise<RootTaskHistoryPage> => {
        expect(limit).toBe(64)
        cursors.push(cursor)
        calls += 1
        return calls === 1
          ? { rows: [], rawRowCount: 64, cursor: first }
          : { rows: [{ accepted: "later" }], rawRowCount: 1, cursor: second }
      },
      validate: async row => typeof row.accepted === "string" ? row.accepted : undefined,
      identity: value => value,
    })
    expect(candidates).toEqual(["later"])
    expect(cursors).toEqual([undefined, first])
  })

  it("keeps each lane within two raw pages even when no candidate survives", async () => {
    const cursors: Array<RootTaskHistorySourceCursor | undefined> = []
    const first: RootTaskHistorySourceCursor = { sequence: "100", turnId: "turn-100", terminalEventId: "event-100" }
    const second: RootTaskHistorySourceCursor = { sequence: "36", turnId: "turn-36", terminalEventId: "event-36" }
    const candidates = await scanRootTaskHistoryPages({
      crossSession: false,
      readPage: async cursor => {
        cursors.push(cursor)
        return { rows: [], rawRowCount: 64, cursor: cursor ? second : first }
      },
      validate: async () => undefined,
      identity: value => String(value),
    })
    expect(candidates).toEqual([])
    expect(cursors).toEqual([undefined, first])
  })

  it("uses UTF-8 byte order to match PostgreSQL C-collated cursor keys", () => {
    const previous = { sequence: "1", turnId: "𐀀", terminalEventId: "event" }
    const next = { sequence: "1", turnId: "\uE000", terminalEventId: "event" }
    expect(rootTaskHistoryCursorAdvanced(previous, next, false)).toBe(true)
    expect(rootTaskHistoryCursorAdvanced(
      { xid8: "8", turnId: "𐀀", terminalEventId: "event", witnessEventId: "witness" },
      { xid8: "8", turnId: "\uE000", terminalEventId: "event", witnessEventId: "witness" },
      true,
    )).toBe(true)
  })

  it("places same-session cursors at their explicit slot after nested aggregate ordering", () => {
    const window = [
      'SELECT event."id", jsonb_agg(item."id" ORDER BY item."ordinality") AS "items"',
      'FROM "agent_events" AS event /* ROOT_HISTORY_CURSOR */',
      'ORDER BY event."sequence" DESC',
    ].join("\n")
    const page = buildRootTaskHistorySameSessionPageWindow(window, false,
      { sequence: "50", turnId: "turn-50", terminalEventId: "event-50" }, 64)
    const aggregateOrder = page.sql.indexOf('ORDER BY item."ordinality"')
    const cursorPredicate = page.sql.indexOf('AND (event."sequence",')
    const finalOrder = page.sql.lastIndexOf('ORDER BY event."sequence" DESC')

    expect(aggregateOrder).toBeGreaterThanOrEqual(0)
    expect(cursorPredicate).toBeGreaterThan(aggregateOrder)
    expect(cursorPredicate).toBeLessThan(finalOrder)
    expect(page.sql).not.toContain("ROOT_HISTORY_CURSOR")
    expect(page.cursorValues).toEqual(["50", "turn-50", "event-50"])
  })
})
