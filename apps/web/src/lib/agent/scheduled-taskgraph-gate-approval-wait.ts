import type { Prisma } from "@prisma/client"
import { SCHEDULED_GATE_REVIEW_MARKER_SCHEMA } from "./approval/gate-replay"
import type { ScheduledTaskGraphGateRequestOwner } from "./scheduled-taskgraph-gate-rpc"

type Row = Record<string, unknown>
const MAX_APPROVALS = 50
const ITEM_CONTENT_KEYS = ["waitKind", "approvalId", "toolCallId", "action", "title", "body", "impact",
  "scopeHash", "receiptRevision", "expiresAt", "decision"] as const

/** Reads current same-Gate approval witnesses after Session, Turn, wait, step and Root are locked. */
export async function scheduledTaskGraphGateApprovalWaitIds(
  tx: Prisma.TransactionClient,
  owner: ScheduledTaskGraphGateRequestOwner,
  gateTaskId: string,
  now = new Date(),
): Promise<string[]> {
  if (!validId(gateTaskId) || !validId(owner.userId) || !validId(owner.sessionId) || !validId(owner.turnId)) return []
  const approvals = await tx.agentApproval.findMany({
    where: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, type: "review_application",
      status: "pending", decidedAt: null, consumedAt: null, expiresAt: { gt: now },
      payload: { path: ["scheduledGateReview", "gateTaskId"], equals: gateTaskId } },
    orderBy: { id: "asc" },
    take: MAX_APPROVALS + 1,
    select: {
      id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true,
      type: true, status: true, title: true, body: true, impact: true, payload: true, scopeHash: true,
      revision: true, expiresAt: true, decidedAt: true, consumedAt: true,
    },
  })
  if (approvals.length > MAX_APPROVALS) return []
  const ids = approvals.flatMap(row => validId(row.id) ? [row.id] : [])
  if (ids.length === 0) return []
  const [items, events] = await Promise.all([
    tx.agentItem.findMany({
      where: { id: { in: ids.map(id => "agent-wait:approval:" + id) }, sessionId: owner.sessionId, turnId: owner.turnId },
      select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
        revision: true, content: true, startedAt: true, completedAt: true },
    }),
    tx.agentEvent.findMany({
      where: { sessionId: owner.sessionId, turnId: owner.turnId, type: "approval.requested", correlationId: { in: ids } },
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
        correlationId: true, idempotencyKey: true, payload: true },
    }),
  ])
  const valid: string[] = []
  for (const approval of approvals) {
    const approvalId = validId(approval.id) ? approval.id : null
    if (!approvalId) continue
    const itemId = "agent-wait:approval:" + approvalId
    const matchingItems = items.filter(item => item.id === itemId)
    const matchingEvents = events.filter(event => event.correlationId === approvalId)
    if (matchingItems.length !== 1 || matchingEvents.length !== 1) continue
    if (validApprovalWitness(approval as unknown as Row, matchingItems[0] as unknown as Row,
      matchingEvents[0] as unknown as Row, owner, gateTaskId, now)) valid.push(approvalId)
  }
  return [...new Set(valid)].sort()
}

function validApprovalWitness(approval: Row, item: Row, event: Row,
  owner: ScheduledTaskGraphGateRequestOwner, gateTaskId: string, now: Date): boolean {
  const approvalId = approval.id, jobId = approval.jobId, taskId = approval.taskId
  const expiresAt = approval.expiresAt
  const payload = record(approval.payload), marker = record(payload?.scheduledGateReview)
  const impact = record(approval.impact), scopeHash = approval.scopeHash, toolCallId = approval.toolCallId
  const content = record(item.content), eventPayload = record(event.payload)
  if (!validId(approvalId) || approval.userId !== owner.userId || approval.sessionId !== owner.sessionId
    || approval.turnId !== owner.turnId || approval.type !== "review_application" || approval.status !== "pending"
    || approval.decidedAt !== null || approval.consumedAt !== null || !(expiresAt instanceof Date) || expiresAt <= now
    || !validId(jobId) || !validId(taskId) || !validId(toolCallId) || typeof scopeHash !== "string" || !scopeHash
    || !Number.isSafeInteger(approval.revision) || Number(approval.revision) < 0
    || !payload || !exactKeys(marker ?? {}, ["schemaVersion", "gateTaskId"])
    || marker?.schemaVersion !== SCHEDULED_GATE_REVIEW_MARKER_SCHEMA || marker.gateTaskId !== gateTaskId
    || payload.jobId !== jobId || payload.applicationTaskId !== taskId
    || !Object.keys(payload).every(key => ["jobId", "applicationTaskId", "artifactBindings", "scheduledGateReview"].includes(key))
    || !impact || !exactKeys(impact, ["externalSubmission", "jobId"])
    || impact.externalSubmission !== false || impact.jobId !== jobId
    || !content || !exactKeys(content, ITEM_CONTENT_KEYS)
    || item.id !== "agent-wait:approval:" + approvalId || item.sessionId !== owner.sessionId || item.turnId !== owner.turnId
    || item.stepId !== null || item.taskId !== null || item.type !== "approval_request" || item.status !== "started"
    || item.revision !== 0 || !(item.startedAt instanceof Date) || item.completedAt !== null
    || content.waitKind !== "approval" || content.approvalId !== approvalId || content.toolCallId !== toolCallId
    || content.action !== "review_application" || content.title !== approval.title || content.body !== approval.body
    || !sameJson(content.impact, impact) || content.scopeHash !== scopeHash || content.receiptRevision !== approval.revision
    || content.expiresAt !== expiresAt.toISOString() || content.decision !== null
    || event.sessionId !== owner.sessionId || event.turnId !== owner.turnId || event.itemId !== null
    || event.taskId !== taskId || event.type !== "approval.requested" || event.actor !== "orchestrator"
    || event.correlationId !== approvalId || event.idempotencyKey !== "approval:" + approvalId + ":requested"
    || !eventPayload || !exactKeys(eventPayload, ["approvalId", "action", "scopeHash", "revision"])
    || eventPayload.approvalId !== approvalId || eventPayload.action !== "review_application"
    || eventPayload.scopeHash !== scopeHash || eventPayload.revision !== approval.revision) return false
  return true
}

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function stableJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  const row = value as Record<string, unknown>
  return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + stableJson(row[key])).join(",") + "}"
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return stableJson(left) === stableJson(right) } catch { return false }
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}