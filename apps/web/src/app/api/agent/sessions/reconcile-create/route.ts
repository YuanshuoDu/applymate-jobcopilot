import { NextRequest, NextResponse } from "next/server"

import { isErrorResponse, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { reconcileIdempotentAgentSession } from "@/lib/agent/session/agent-session-create-idempotency"
import { taskRecoveryAccountScope } from "@/lib/agent/control-plane/commands/objective-start-attempt-read-model"

const MAX_BODY_BYTES = 512
const MAX_KEY_LENGTH = 128

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function json(data: unknown, status = 200): NextResponse {
  return noStore(NextResponse.json(data, { status }))
}

function scopedJson(accountScope: string, data: unknown, status = 200): NextResponse {
  const response = json(data, status)
  response.headers.set("X-Account-Scope", accountScope)
  return response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_KEY_LENGTH && /^[!-~]+$/.test(value)
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null && (!/^[0-9]{1,6}$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) return null
  if (!request.body) return null

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let chunkCount = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      if (++chunkCount > MAX_BODY_BYTES + 1) return null
      const chunk = item.value ?? new Uint8Array()
      byteLength += chunk.byteLength
      if (byteLength > MAX_BODY_BYTES) return null
      chunks.push(chunk)
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  if (byteLength === 0) return null
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown } catch { return null }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)

  const accountScope = taskRecoveryAccountScope(auth.userId)
  if (request.headers.get("x-expected-account-scope") !== accountScope) {
    return scopedJson(accountScope, { error: "Task recovery account scope changed", accountScope }, 409)
  }
  const body = await readBoundedJson(request)
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "idempotencyKey")
    || !validIdempotencyKey(body.idempotencyKey)) {
    return scopedJson(accountScope, { error: "Invalid Session reconciliation request" }, 422)
  }

  try {
    return scopedJson(accountScope, { accountScope, ...(await reconcileIdempotentAgentSession(db, auth.userId, body.idempotencyKey)) })
  } catch {
    return scopedJson(accountScope, { error: "Could not reconcile Session creation" }, 500)
  }
}
