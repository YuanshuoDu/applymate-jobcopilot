import { describe, expect, it } from "vitest"
import {
  buildRootTaskHistorySameSessionPageWindow, parseRootTaskHistoryPage, rootTaskHistoryCursorAdvanced, scanRootTaskHistoryPages,
  type RootTaskHistoryPage, type RootTaskHistorySourceCursor,
} from "./root-task-history-source-page.js"

describe("root task history source paging", () => {
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
