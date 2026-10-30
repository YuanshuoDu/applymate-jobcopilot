import { Buffer } from "node:buffer"
import type { RootTaskHistoryFence, RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import { hasSelectedJobPreparation, rootTaskHistoryIndexKeys, rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin } from "./root-task-history-fence.js"
import { parseRootTaskHistoryChronologyXid8 } from "./root-task-history-chronology-witness.js"
import { OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION } from "./objective-history-projection.js"
import { isScheduledAutomationTurn, sameScheduledAutomationCriteria, scheduledAutomationCriteria } from "../subagents/scheduled-automation-snapshot.js"
import {
  isHistoryReceiptText as text,
  parseHistoryReceiptSequence as sequence,
  validateHistoryStartReceipt as validStart,
  validateHistoryTerminalReceipt as validTerminal,
} from "./root-task-history-terminal-receipts.js"
import type { RootTaskHistoryCrossSessionCursor } from "./root-task-history-source-window.js"

export type RootTaskHistorySourceRow = Record<string, unknown>
type SameCursor = Readonly<{ sequence: string; turnId: string; terminalEventId: string }>
export type RootTaskHistorySourceCursor = SameCursor | RootTaskHistoryCrossSessionCursor
export type RootTaskHistoryPage = Readonly<{
  rows: readonly RootTaskHistorySourceRow[]; rawRowCount: number; cursor: RootTaskHistorySourceCursor | null
}>

export type RootTaskHistoryCandidate = Readonly<{
  sessionId: string
  turnId: string
  rootTaskId: string
  terminalEventId: string
  terminalSequence: bigint
  terminalXid8?: string
  terminalWitnessEventId?: string
}>

export const ROOT_TASK_HISTORY_PAGE_SIZE = 64
const RAW_LANE_BUDGET = 128
const VALID_CANDIDATE_TARGET = 64

export function parseRootTaskHistoryPage(rows: readonly RootTaskHistorySourceRow[],
  crossSession: boolean): RootTaskHistoryPage | undefined {
  if (!rows.length || rows.some(row => typeof row.pageRawRowCount !== "number"
    || !Number.isInteger(row.pageRawRowCount) || row.pageSentinelCount !== 1 || row.pageServerEncoding !== "UTF8")) return undefined
  const rawRowCount = rows[0]!.pageRawRowCount as number
  if (rawRowCount < 0 || rawRowCount > ROOT_TASK_HISTORY_PAGE_SIZE
    || rows.some(row => row.pageRawRowCount !== rawRowCount)) return undefined
  const watermarkRows = rows.filter(row => row.isPageWatermark === true)
  const candidates = rows.filter(row => row.isPageWatermark === false)
  if (rows.some(row => row.isPageWatermark !== true && row.isPageWatermark !== false)
    || candidates.length > rawRowCount || watermarkRows.length > 1) return undefined
  const metadata = rows[0]!
  if (rows.some(row => ["pageCursorSequence", "pageCursorXid8", "pageCursorTurnId",
    "pageCursorTerminalEventId", "pageCursorWitnessEventId"].some(key => row[key] !== metadata[key]))) return undefined
  if (candidates.length === 0 && watermarkRows.length !== 1) return undefined
  if (candidates.length > 0 && watermarkRows.length !== 0) return undefined
  if (rawRowCount === 0) {
    if (watermarkRows.length !== 1 || candidates.length !== 0
      || ["pageCursorSequence", "pageCursorXid8", "pageCursorTurnId",
        "pageCursorTerminalEventId", "pageCursorWitnessEventId"].some(key => metadata[key] !== null)) return undefined
    return { rows: [], rawRowCount, cursor: null }
  }
  const cursor: RootTaskHistorySourceCursor | undefined = crossSession
    ? text(metadata.pageCursorXid8) && /^\d+$/.test(metadata.pageCursorXid8)
      && text(metadata.pageCursorTurnId) && text(metadata.pageCursorTerminalEventId) && text(metadata.pageCursorWitnessEventId)
      ? { xid8: metadata.pageCursorXid8, turnId: metadata.pageCursorTurnId,
        terminalEventId: metadata.pageCursorTerminalEventId, witnessEventId: metadata.pageCursorWitnessEventId } : undefined
    : text(metadata.pageCursorSequence) && /^\d+$/.test(metadata.pageCursorSequence)
      && text(metadata.pageCursorTurnId) && text(metadata.pageCursorTerminalEventId)
      ? { sequence: metadata.pageCursorSequence, turnId: metadata.pageCursorTurnId,
        terminalEventId: metadata.pageCursorTerminalEventId } : undefined
  if (!cursor) return undefined
  return { rows: candidates.map(stripRootTaskHistoryPageMetadata), rawRowCount, cursor }
}

export function buildRootTaskHistorySameSessionPageWindow(window: string, indexed: boolean,
  cursor: RootTaskHistorySourceCursor | undefined, limit: number): Readonly<{ sql: string; cursorValues: readonly unknown[] }> {
  const sameCursor = cursor as SameCursor | undefined
  const cursorSql = sameCursor ? indexed
    ? 'AND (turn."terminalEventSequence", turn."id"::text COLLATE "C") < ($9::bigint, $10::text COLLATE "C")'
    : 'AND (event."sequence", event."turnId"::text COLLATE "C", event."id"::text COLLATE "C") < ($7::bigint, $8::text COLLATE "C", $9::text COLLATE "C")'
    : ""
  const cursorSlot = "/* ROOT_HISTORY_CURSOR */"
  if (!window.includes(cursorSlot)) throw new Error("Same-session root task history query is missing its cursor slot")
  const orderedWindow = window.replace(cursorSlot, cursorSql)
  const limitParameter = indexed ? "$8" : "$6"
  return {
    sql: `WITH raw_page AS MATERIALIZED (${orderedWindow} LIMIT ${limitParameter}), watermark AS (
      SELECT raw."sequence"::text AS "pageCursorSequence", raw."turnId"::text AS "pageCursorTurnId",
        COALESCE(raw."terminalEventId"::text, raw."turnId"::text) AS "pageCursorTerminalEventId"
      FROM raw_page AS raw
      ORDER BY raw."sequence" ASC, raw."turnId"::text COLLATE "C" ASC,
        COALESCE(raw."terminalEventId"::text, raw."turnId"::text) COLLATE "C" ASC LIMIT 1
    )
    SELECT raw_page.*, FALSE AS "isPageWatermark", NULL::text AS "pageCursorSequence", NULL::text AS "pageCursorXid8",
      NULL::text AS "pageCursorTurnId", NULL::text AS "pageCursorTerminalEventId", NULL::text AS "pageCursorWitnessEventId",
      NULL::integer AS "pageRawRowCount", NULL::text AS "pageServerEncoding"
    FROM raw_page
    UNION ALL
    SELECT NULL::text AS "terminalEventId", NULL::text AS "sessionId", NULL::text AS "turnId", NULL::text AS "taskId",
      NULL::bigint AS "sequence", NULL::timestamptz AS "createdAt", NULL::text AS "terminalWitnessEventId",
      NULL::text AS "terminalWitnessXid8", NULL::bigint AS "terminalWitnessCount", TRUE AS "isPageWatermark",
      (SELECT "pageCursorSequence" FROM watermark) AS "pageCursorSequence", NULL::text AS "pageCursorXid8",
      (SELECT "pageCursorTurnId" FROM watermark) AS "pageCursorTurnId",
      (SELECT "pageCursorTerminalEventId" FROM watermark) AS "pageCursorTerminalEventId",
      NULL::text AS "pageCursorWitnessEventId", (SELECT COUNT(*)::integer FROM raw_page) AS "pageRawRowCount",
      current_setting('server_encoding') AS "pageServerEncoding"`,
    cursorValues: sameCursor ? indexed ? [sameCursor.sequence, sameCursor.turnId]
      : [sameCursor.sequence, sameCursor.turnId, sameCursor.terminalEventId] : [],
  }
}

function stripRootTaskHistoryPageMetadata(row: RootTaskHistorySourceRow): RootTaskHistorySourceRow {
  const candidate = { ...row }
  for (const key of ["isPageWatermark", "pageCursorSequence", "pageCursorXid8", "pageCursorTurnId",
    "pageCursorTerminalEventId", "pageCursorWitnessEventId", "pageRawRowCount", "pageSentinelCount", "pageServerEncoding"]) delete candidate[key]
  return candidate
}

export function validateRootTaskHistoryCandidate(row: RootTaskHistorySourceRow, input: RootTaskHistoryFenceInput,
  fence: RootTaskHistoryFence, indexed = false): RootTaskHistoryCandidate | undefined {
  const turnId = row.turnId, rootTaskId = row.taskRootTaskId
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  const terminalEventId = text(row.terminalEventId) ? row.terminalEventId : undefined
  const scheduledTurn = isScheduledAutomationTurn(row.turnSource, row.input)
  const scheduledCriteria = scheduledTurn ? scheduledAutomationCriteria(row.input) : undefined
  if (!text(turnId) || !text(rootTaskId) || !text(row.sessionId) || !terminalEventId || turnId === input.lease.turnId
    || (!crossSession && row.sessionId !== input.lease.sessionId) || row.userId !== input.lease.userId
    || (crossSession && row.sessionId === input.lease.sessionId)
    || row.rootTaskId !== rootTaskId || row.taskId !== rootTaskId || row.taskTurnId !== turnId
    || row.parentTaskId !== null || row.taskRole !== "orchestrator" || row.taskType !== "root"
    || !["completed", "failed", "interrupted"].includes(String(row.turnStatus))
    || row.turnStatus !== row.taskStatus || hasSelectedJobPreparation(row.input)) return undefined
  if (fence.scheduledAutomationCriteria
    ? !scheduledTurn || !scheduledCriteria || !sameScheduledAutomationCriteria(scheduledCriteria, fence.scheduledAutomationCriteria)
    : scheduledTurn) return undefined
  if (crossSession && (row.sourceSessionUserId !== input.lease.userId || ["aborted", "archived"].includes(String(row.sourceSessionStatus))
    || rootTaskHistoryOrigin(row.turnSource, row.input) !== fence.currentOrigin)) return undefined
  const start = validStart(row, turnId, rootTaskId)
  const terminal = start === undefined ? undefined : validTerminal(row, turnId, rootTaskId, String(row.turnStatus), start)
  const terminalAt = row.terminalCreatedAt instanceof Date && Number.isFinite(row.terminalCreatedAt.getTime()) ? row.terminalCreatedAt : undefined
  const terminalXid8 = crossSession ? row.terminalWitnessXid8 : undefined
  const terminalWitnessEventId = crossSession ? row.terminalWitnessEventId : undefined
  const terminalOrder = crossSession ? parseRootTaskHistoryChronologyXid8(terminalXid8) : undefined
  const startOrder = crossSession && fence.currentStartWitness ? parseRootTaskHistoryChronologyXid8(fence.currentStartWitness.xid8) : undefined
  if (start === undefined || terminal === undefined || start >= terminal
    || (!crossSession && terminal >= fence.currentStartSequence)
    || (crossSession && (!startOrder || !terminalOrder || terminalOrder >= startOrder
      || !text(terminalWitnessEventId) || Number(row.terminalWitnessCount) !== 1))
    || rootTaskHistoryObjectiveDigest(row.input, { goal: row.goal, successCriteria: row.successCriteria }) !== fence.objectiveDigest) return undefined
  if (indexed) {
    const keys = rootTaskHistoryIndexKeys(row.turnSource, row.input, { goal: row.goal, successCriteria: row.successCriteria }, crossSession)
    if (!keys || row.turnObjectiveDigest !== keys.objectiveDigest
      || keys.objectiveDigest !== fence.objectiveHistoryIndexObjectiveDigest
      || row.turnObjectiveIndexSemanticsVersion !== OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION
      || sequence(row.indexedTerminalSequence) !== terminal
      || !(row.indexedTerminalAt instanceof Date) || row.indexedTerminalAt.getTime() !== terminalAt?.getTime()) return undefined
    if (crossSession && (!keys.canonicalOriginDigest
      || row.turnCanonicalOriginDigest !== keys.canonicalOriginDigest
      || keys.canonicalOriginDigest !== fence.objectiveHistoryIndexCanonicalOriginDigest)) return undefined
  }
  return { sessionId: row.sessionId, turnId, rootTaskId, terminalEventId, terminalSequence: terminal,
    ...(crossSession && terminalOrder ? { terminalXid8: terminalOrder.toString(), terminalWitnessEventId: terminalWitnessEventId as string } : {}) }
}

function textOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

export function rootTaskHistoryCursorAdvanced(previous: RootTaskHistorySourceCursor | undefined,
  next: RootTaskHistorySourceCursor, crossSession: boolean): boolean {
  if (!previous) return true
  if (crossSession) {
    const before = previous as RootTaskHistoryCrossSessionCursor, after = next as RootTaskHistoryCrossSessionCursor
    const left = BigInt(before.xid8), right = BigInt(after.xid8)
    if (left !== right) return right < left
    for (const [a, b] of [[before.turnId, after.turnId], [before.terminalEventId, after.terminalEventId], [before.witnessEventId, after.witnessEventId]]) {
      const order = textOrder(a, b)
      if (order !== 0) return order > 0
    }
    return false
  }
  const before = previous as SameCursor, after = next as SameCursor
  const left = BigInt(before.sequence), right = BigInt(after.sequence)
  if (left !== right) return right < left
  for (const [a, b] of [[before.turnId, after.turnId], [before.terminalEventId, after.terminalEventId]]) {
    const order = textOrder(a, b)
    if (order !== 0) return order > 0
  }
  return false
}

export async function scanRootTaskHistoryPages<Candidate>(input: Readonly<{
  crossSession: boolean
  readPage: (cursor: RootTaskHistorySourceCursor | undefined, limit: number) => Promise<RootTaskHistoryPage>
  validate: (row: RootTaskHistorySourceRow) => Promise<Candidate | undefined>
  identity: (candidate: Candidate) => string
}>): Promise<Candidate[]> {
  const output: Candidate[] = [], seen = new Set<string>()
  let cursor: RootTaskHistorySourceCursor | undefined, rawScanned = 0
  while (rawScanned < RAW_LANE_BUDGET && output.length < VALID_CANDIDATE_TARGET) {
    const limit = Math.min(ROOT_TASK_HISTORY_PAGE_SIZE, RAW_LANE_BUDGET - rawScanned)
    const page = await input.readPage(cursor, limit)
    if (!Number.isInteger(page.rawRowCount) || page.rawRowCount < 0 || page.rawRowCount > limit
      || page.rows.length > page.rawRowCount) throw new Error("Root task history page bounds are invalid")
    if (page.rawRowCount === 0) {
      if (page.cursor !== null || page.rows.length !== 0) throw new Error("Empty root task history page has a cursor")
      break
    }
    if (!page.cursor || !rootTaskHistoryCursorAdvanced(cursor, page.cursor, input.crossSession)) {
      throw new Error("Root task history page cursor did not advance")
    }
    rawScanned += page.rawRowCount
    for (const row of page.rows) {
      const candidate = await input.validate(row)
      if (!candidate) continue
      const key = input.identity(candidate)
      if (!seen.has(key)) { seen.add(key); output.push(candidate) }
      if (output.length === VALID_CANDIDATE_TARGET) break
    }
    cursor = page.cursor
    if (page.rawRowCount < limit) break
  }
  return output
}
