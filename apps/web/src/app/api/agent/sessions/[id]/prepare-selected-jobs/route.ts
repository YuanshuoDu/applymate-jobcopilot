import { NextRequest } from "next/server"

import {
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  parseVerifiedShortlistJobIds,
  parseVerifiedShortlistSourceIdentity,
} from "@jobcopilot/agent-protocol"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { SelectedJobBatchCommandService } from "@/lib/agent/control-plane/commands/selected-job-batch-command"
import { invalidCommand } from "@/lib/agent/control-plane/commands/errors"
import { commandErrorResponse, isResponse, readJsonBody } from "../../command-route-helpers"

interface RouteContext {
  params: Promise<{ id: string }>
}

type ParsedBatchBody = Readonly<{
  clientMessageId: string
  sourceIdentity: NonNullable<ReturnType<typeof parseVerifiedShortlistSourceIdentity>>
  selectedJobIds: NonNullable<ReturnType<typeof parseVerifiedShortlistJobIds>>
}>

function privateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function exactRecord(value: unknown): Record<string, unknown> | null {
  const expected = ["schemaVersion", "clientMessageId", "source", "selectedJobIds"]
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expected.length
      || keys.some(key => typeof key !== "string" || !expected.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

function parseBody(value: unknown, request: Request, sessionId: string): ParsedBatchBody | null {
  const body = exactRecord(value)
  if (!body || body.schemaVersion !== VERIFIED_SHORTLIST_SELECTION_SCHEMA) return null
  const clientMessageId = body.clientMessageId
  const idempotencyKey = request.headers.get("idempotency-key")
  if (typeof clientMessageId !== "string" || !/^[!-~]{1,128}$/.test(clientMessageId)
    || idempotencyKey !== clientMessageId) return null
  const sourceIdentity = parseVerifiedShortlistSourceIdentity(body.source)
  const selectedJobIds = parseVerifiedShortlistJobIds(body.selectedJobIds)
  if (!sourceIdentity || sourceIdentity.sessionId !== sessionId || !selectedJobIds) return null
  return { clientMessageId, sourceIdentity, selectedJobIds }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return privateNoStore(auth)

  const { id: sessionId } = await context.params
  const body = await readJsonBody(request)
  if (isResponse(body)) return privateNoStore(body)
  const command = parseBody(body, request, sessionId)
  if (!command) return privateNoStore(commandErrorResponse(invalidCommand("Invalid selected Job batch command payload")))

  try {
    const result = await new SelectedJobBatchCommandService(db).start({
      sessionId,
      userId: auth.userId,
      clientMessageId: command.clientMessageId,
      source: "user",
      sourceIdentity: command.sourceIdentity,
      selectedJobIds: command.selectedJobIds,
    })
    return privateNoStore(ok(result, 202))
  } catch (error: unknown) {
    return privateNoStore(commandErrorResponse(error))
  }
}
