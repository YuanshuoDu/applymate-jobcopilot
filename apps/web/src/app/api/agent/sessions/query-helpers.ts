import { NextResponse } from "next/server"

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export type QueryCollection = "timeline" | "turns" | "tasks"

export interface QueryCursor {
  collection: QueryCollection
  sessionId: string
  createdAt: string
  id: string
}

export interface PageRequest {
  limit: number
  cursor: QueryCursor | null
}

export interface CursorRow {
  id: string
  createdAt: Date | string
}

type CursorFilter = {
  OR: Array<
    | { createdAt: { gt: Date } }
    | { createdAt: Date; id: { gt: string } }
  >
}

function queryError(code: string, message: string, status = 400): NextResponse {
  return NextResponse.json({ error: { code, message, details: {} } }, { status })
}

export function sessionNotFound(): NextResponse {
  return queryError("session_not_found", "Session not found", 404)
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function decodeCursor(raw: string): QueryCursor | null {
  if (raw.length > 512) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>
    const keys = Object.keys(parsed).sort().join(",")
    if (keys !== "collection,createdAt,id,sessionId") return null
    if (parsed.collection !== "timeline" && parsed.collection !== "turns" && parsed.collection !== "tasks") return null
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length < 1 || parsed.sessionId.length > 256) return null
    if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 256) return null
    if (!validIso(parsed.createdAt)) return null
    return {
      collection: parsed.collection,
      sessionId: parsed.sessionId,
      createdAt: parsed.createdAt,
      id: parsed.id,
    }
  } catch {
    return null
  }
}

function encodeCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function cursorIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function parsePageRequest(
  request: Request,
  collection: QueryCollection,
  sessionId: string,
): PageRequest | NextResponse {
  const params = new URL(request.url).searchParams
  const rawLimit = params.get("limit")
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return queryError("invalid_page_size", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }

  const rawCursor = params.get("cursor")
  if (!rawCursor) return { limit, cursor: null }
  const cursor = decodeCursor(rawCursor)
  if (!cursor || cursor.collection !== collection || cursor.sessionId !== sessionId) {
    return queryError("invalid_cursor", "Cursor is invalid or belongs to another query")
  }
  return { limit, cursor }
}

export function afterCursor(cursor: QueryCursor | null): CursorFilter | Record<string, never> {
  if (!cursor) return {}
  const createdAt = new Date(cursor.createdAt)
  return {
    OR: [
      { createdAt: { gt: createdAt } },
      { createdAt, id: { gt: cursor.id } },
    ],
  }
}

export function pageResult<T extends CursorRow>(
  rows: T[],
  page: PageRequest,
  collection: QueryCollection,
  sessionId: string,
): { rows: T[]; page: { hasMore: boolean; nextCursor: string | null } } {
  const hasMore = rows.length > page.limit
  const visible = rows.slice(0, page.limit)
  const last = visible[visible.length - 1]
  return {
    rows: visible,
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({ collection, sessionId, id: last.id, createdAt: cursorIso(last.createdAt) })
        : null,
    },
  }
}

export function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
