import { NextRequest } from "next/server"

import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { decideObjectiveApplicationReviewMember } from "@/lib/agent/broker/objective-application-review-decision-service"
import { readObjectiveApplicationReviewSnapshot } from "@/lib/agent/broker/objective-application-review-snapshot"
import { db } from "@/lib/db"
import { runWithTenantContext } from "@/lib/db/tenant-store"
import { isResponse, readJsonBody } from "../../../command-route-helpers"
import { waitErrorResponse } from "../../../wait-route-helpers"

interface RouteContext { params: Promise<{ id: string; turnId: string }> }
type Snapshot = Readonly<{
  turnId: string; turnRevision: number; setStatus: "pending" | "resolved"
  members: readonly Readonly<{
    slotOrdinal: number; approvalId: string; status: "pending" | "approved" | "rejected" | "expired"
    receiptRevision: number; job: Readonly<{ company: string; role: string }>
    artifactRef: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
    resumeId: string; decisionAvailable: boolean
  }>[]
}>
type DecisionBody = Readonly<{
  approvalId: string; expectedRevision: number; expectedReceiptRevision: number
  idempotencyKey: string; decision: "approved" | "rejected"
}>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const DECISION_KEYS = "approvalId,decision,expectedReceiptRevision,expectedRevision,idempotencyKey"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)
  const { id: sessionId, turnId } = await context.params
  if (!ID.test(sessionId) || !ID.test(turnId)) return noStore(err("Review status is unavailable", 404))
  if (new URL(request.url).searchParams.size !== 0) return noStore(err("Unexpected review status query", 400))
  try {
    const result = await runWithTenantContext(auth.userId, () => readObjectiveApplicationReviewSnapshot(db, {
      userId: auth.userId, sessionId, turnId,
    }))
    const snapshot = parseSnapshot(result)
    return snapshot?.turnId === turnId ? noStore(ok({ snapshot })) : noStore(err("Review status is unavailable", 404))
  } catch {
    return noStore(err("Review status is unavailable", 500))
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)
  const { id: sessionId, turnId } = await context.params
  if (!ID.test(sessionId) || !ID.test(turnId)
    || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return noStore(err("Invalid application review decision", 422))
  }
  const raw = await readJsonBody(request)
  if (isResponse(raw)) return noStore(raw)
  const body = parseDecisionBody(raw)
  if (!body) return noStore(err("Invalid application review decision", 422))
  try {
    const result = await runWithTenantContext(auth.userId, () => decideObjectiveApplicationReviewMember(db, {
      approvalId: body.approvalId, userId: auth.userId, sessionId, expectedTurnId: turnId,
      expectedRevision: body.expectedRevision, expectedReceiptRevision: body.expectedReceiptRevision,
      clientMessageId: body.idempotencyKey, decision: body.decision,
    }))
    return noStore(ok({ disposition: result.disposition, status: result.status,
      setCompleted: result.setCompleted, turnRevision: result.nextTurnRevision }, result.disposition === "duplicate" ? 200 : 202))
  } catch (error: unknown) {
    return noStore(waitErrorResponse(error))
  }
}

function parseDecisionBody(value: unknown): DecisionBody | null {
  const row = record(value)
  if (!row || Object.keys(row).sort().join(",") !== DECISION_KEYS || typeof row.approvalId !== "string" || !ID.test(row.approvalId)
    || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 0
    || !Number.isSafeInteger(row.expectedReceiptRevision) || Number(row.expectedReceiptRevision) < 0
    || typeof row.idempotencyKey !== "string" || row.idempotencyKey.length < 1 || row.idempotencyKey.length > 128
    || !/^[!-~]+$/.test(row.idempotencyKey) || (row.decision !== "approved" && row.decision !== "rejected")) return null
  return { approvalId: row.approvalId as string, expectedRevision: Number(row.expectedRevision),
    expectedReceiptRevision: Number(row.expectedReceiptRevision), idempotencyKey: row.idempotencyKey, decision: row.decision }
}

function parseSnapshot(value: unknown): Snapshot | null {
  const row = record(value)
  if (!row || Object.keys(row).sort().join(",") !== "members,setStatus,turnId,turnRevision"
    || typeof row.turnId !== "string" || !ID.test(row.turnId) || !Number.isSafeInteger(row.turnRevision)
    || Number(row.turnRevision) < 0 || (row.setStatus !== "pending" && row.setStatus !== "resolved")
    || !Array.isArray(row.members) || row.members.length < 1 || row.members.length > 8) return null
  if (Object.getPrototypeOf(row.members) !== Array.prototype || Reflect.ownKeys(row.members).length !== row.members.length + 1) return null
  const members: Snapshot["members"][number][] = [], approvals = new Set<string>()
  let previousOrdinal = 0
  for (let index = 0; index < row.members.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(row.members, String(index))
    const member = descriptor && "value" in descriptor ? record(descriptor.value) : null
    const job = record(member?.job), ref = record(member?.artifactRef)
    if (!member || Object.keys(member).sort().join(",") !== "approvalId,artifactRef,decisionAvailable,job,receiptRevision,resumeId,slotOrdinal,status"
      || !Number.isSafeInteger(member.slotOrdinal) || Number(member.slotOrdinal) < 1 || Number(member.slotOrdinal) > 8
      || Number(member.slotOrdinal) <= previousOrdinal || typeof member.approvalId !== "string" || !ID.test(member.approvalId)
      || approvals.has(member.approvalId) || !["pending", "approved", "rejected", "expired"].includes(String(member.status))
      || !Number.isSafeInteger(member.receiptRevision) || Number(member.receiptRevision) < 0
      || typeof member.resumeId !== "string" || !ID.test(member.resumeId) || typeof member.decisionAvailable !== "boolean"
      || member.decisionAvailable && member.status !== "pending" || !job || Object.keys(job).sort().join(",") !== "company,role"
      || !boundedText(job.company, 160) || !boundedText(job.role, 160) || !ref
      || Object.keys(ref).sort().join(",") !== "artifactId,contentHash,sourceDigest,version" || typeof ref.artifactId !== "string"
      || !ID.test(ref.artifactId) || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1
      || typeof ref.contentHash !== "string" || !DIGEST.test(ref.contentHash)
      || typeof ref.sourceDigest !== "string" || !DIGEST.test(ref.sourceDigest)) return null
    approvals.add(member.approvalId); previousOrdinal = Number(member.slotOrdinal)
    members.push({ slotOrdinal: Number(member.slotOrdinal), approvalId: member.approvalId, status: member.status as Snapshot["members"][number]["status"],
      receiptRevision: Number(member.receiptRevision), job: { company: job.company, role: job.role },
      artifactRef: { artifactId: ref.artifactId, version: Number(ref.version), contentHash: ref.contentHash, sourceDigest: ref.sourceDigest },
      resumeId: member.resumeId, decisionAvailable: member.decisionAvailable })
  }
  if (row.setStatus === "resolved" && members.some(member => member.status === "pending" || member.decisionAvailable)
    || row.setStatus === "pending" && !members.some(member => member.status === "pending")) return null
  return { turnId: row.turnId, turnRevision: Number(row.turnRevision), setStatus: row.setStatus, members }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as Record<string, unknown>
  } catch { return null }
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store, max-age=0")
  return response
}
