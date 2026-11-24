import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import {
  processReviewedFillHandoffOutbox,
  ReviewedFillHandoffOutboxNotFoundError,
} from "@/lib/agent/approval/reviewed-fill-handoff-outbox"

const STATUSES = ["queued", "duplicate", "deferred", "terminal"] as const

function authorized(request: NextRequest): boolean {
  const secret = process.env.AGENT_WORKER_SECRET
  return Boolean(secret) && request.headers.get("x-agent-worker-secret") === secret
}

async function readBoundedText(request: NextRequest): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > 1024) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > 1024) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    return null
  }
}

async function parseOutboxId(request: NextRequest): Promise<string | null> {
  const text = await readBoundedText(request)
  if (text === null || text.length === 0) return null
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || Object.keys(record)[0] !== "outboxId") return null
    return typeof record.outboxId === "string" && record.outboxId.trim() === record.outboxId
      && record.outboxId.length > 0 && record.outboxId.length <= 256 ? record.outboxId : null
  } catch {
    return null
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const outboxId = await parseOutboxId(request)
  if (!outboxId) return NextResponse.json({ error: "Invalid handoff request" }, { status: 400 })
  try {
    const status = await processReviewedFillHandoffOutbox(db, outboxId)
    if (!STATUSES.some((candidate) => candidate === status)) {
      return NextResponse.json({ error: "Handoff unavailable" }, { status: 503 })
    }
    return NextResponse.json({ status })
  } catch (error: unknown) {
    if (error instanceof ReviewedFillHandoffOutboxNotFoundError) {
      return NextResponse.json({ error: "Handoff not found" }, { status: 404 })
    }
    return NextResponse.json({ error: "Handoff unavailable" }, { status: 503 })
  }
}
