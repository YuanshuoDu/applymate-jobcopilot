import { NextRequest, NextResponse } from "next/server"

import { applicationFillTaskGraphEnabled } from "@/lib/auto-apply"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { ReviewedApplicationReviewCommandService } from "@/lib/agent/control-plane/commands/reviewed-application-review"
import { db } from "@/lib/db"

import { commandErrorResponse } from "../../command-route-helpers"

interface RouteContext { params: Promise<{ id: string }> }
interface RequestBody { sourceTurnId: string; idempotencyKey: string }

const MAX_BODY_BYTES = 1024
const MAX_ID_LENGTH = 256
const MAX_KEY_LENGTH = 128

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseBody(value: unknown): RequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(",") !== "idempotencyKey,sourceTurnId"
      || !validIdentity(row.sourceTurnId)
      || typeof row.idempotencyKey !== "string" || row.idempotencyKey.length < 1
      || row.idempotencyKey.length > MAX_KEY_LENGTH || !/^[!-~]+$/.test(row.idempotencyKey)) return null
    return { sourceTurnId: row.sourceTurnId, idempotencyKey: row.idempotencyKey }
  } catch {
    return null
  }
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && (!/^\d{1,6}$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) return null
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown } catch { return null }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)
  if (!applicationFillTaskGraphEnabled()) return noStore(err("Reviewed application review is unavailable while TaskGraph fill is disabled", 409))

  const { id: sessionId } = await context.params
  const body = parseBody(await readBoundedJson(request))
  if (!body) return noStore(err("Invalid reviewed application review request", 422))
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return noStore(err("Session not found", 404))

  try {
    const result = await new ReviewedApplicationReviewCommandService(db).start({
      sessionId, userId: auth.userId, clientMessageId: body.idempotencyKey, sourceTurnId: body.sourceTurnId,
    })
    const response = ok({ turnId: result.turnId, disposition: result.disposition }, result.disposition === "duplicate" ? 200 : 202)
    return noStore(response)
  } catch (error: unknown) {
    return noStore(commandErrorResponse(error))
  }
}
