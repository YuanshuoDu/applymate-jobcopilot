import { NextRequest } from "next/server"

import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { parseObjectiveApplicationReviewIntent } from "@jobcopilot/agent-protocol"
import { ObjectiveApplicationReviewCommandService } from "@/lib/agent/control-plane/commands/objective-application-review"
import { db } from "@/lib/db"
import { runWithTenantContext } from "@/lib/db/tenant-store"

import { commandErrorResponse } from "../../command-route-helpers"

interface RouteContext { params: Promise<{ id: string }> }
interface RequestBody { idempotencyKey: string; selection: NonNullable<ReturnType<typeof parseObjectiveApplicationReviewIntent>> }

const MAX_BODY_BYTES = 4096
const MAX_KEY_LENGTH = 128

function parseBody(value: unknown): RequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(",") !== "idempotencyKey,selection"
      || typeof row.idempotencyKey !== "string" || row.idempotencyKey.length < 1
      || row.idempotencyKey.length > MAX_KEY_LENGTH || !/^[!-~]+$/.test(row.idempotencyKey)) return null
    const selection = parseObjectiveApplicationReviewIntent(row.selection)
    return selection ? { idempotencyKey: row.idempotencyKey, selection } : null
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
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return noStore(err("Invalid Objective application review request", 422))
  }
  const { id: sessionId } = await context.params
  const body = parseBody(await readBoundedJson(request))
  if (!body) return noStore(err("Invalid Objective application review request", 422))

  try {
    return noStore(await runWithTenantContext(auth.userId, async () => {
      const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
      if (!session) return err("Session not found", 404)
      const result = await new ObjectiveApplicationReviewCommandService(db).start({
        sessionId, userId: auth.userId, clientMessageId: body.idempotencyKey, selection: body.selection,
      })
      return ok({ turnId: result.turnId, disposition: result.disposition }, result.disposition === "duplicate" ? 200 : 202)
    }))
  } catch (error: unknown) {
    return noStore(commandErrorResponse(error))
  }
}
