import type { ApprovalLedgerActionRef } from './approval-ledger-view'

export type ApprovalDecision = 'approved' | 'rejected'

export interface ApprovalActionRequest {
  readonly sessionId: string
  readonly actionRef: ApprovalLedgerActionRef
  readonly expectedRevision: number
  readonly decision: ApprovalDecision
  readonly clientMessageId: string
}

export interface ApprovalActionResult {
  readonly disposition: 'resolved' | 'duplicate'
}

export class AgentApprovalActionError extends Error {
  readonly status: number

  constructor(status: number) {
    super('Approval decision request failed')
    this.name = 'AgentApprovalActionError'
    this.status = status
  }
}

let clientMessageSequence = 0

/** Generates a fresh id without exposing receipt or server identifiers. */
export function createAgentApprovalMessageId(): string {
  clientMessageSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-approval-${randomId}-${clientMessageSequence}`
}

/** Prevents a late response from changing a later session or approval selection. */
export function isCurrentAgentApprovalRequest(
  currentEpoch: number,
  requestEpoch: number,
  currentSelectionKey: string,
  requestSelectionKey: string,
): boolean {
  return currentEpoch === requestEpoch && currentSelectionKey === requestSelectionKey
}

export async function postAgentApprovalDecision(
  request: ApprovalActionRequest,
  fetcher: typeof fetch = fetch,
): Promise<ApprovalActionResult> {
  try {
    const url = `/api/agent/sessions/${encodeURIComponent(request.sessionId)}/approvals/${encodeURIComponent(request.actionRef.approvalId)}`
    const reviewedApproval = request.decision === 'approved' && isReviewedApplicationApproval(request.actionRef)
    const receiptNonce = reviewedApproval ? await getReviewedApprovalNonce(url, request.actionRef.approvalId, fetcher) : undefined
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
      body: JSON.stringify({
        clientMessageId: request.clientMessageId,
        expectedTurnId: request.actionRef.turnId,
        expectedRevision: request.expectedRevision,
        decision: request.decision,
        ...(receiptNonce ? { receiptNonce } : {}),
      }),
    }
    return await postDecision(url, init, fetcher, reviewedApproval)
  } catch (error: unknown) {
    if (error instanceof AgentApprovalActionError) throw error
    throw new AgentApprovalActionError(0)
  }
}

async function getReviewedApprovalNonce(url: string, approvalId: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok || response.status !== 200 || !isRecord(body) || body.approvalId !== approvalId || !isReceiptNonce(body.receiptNonce)) {
    throw new AgentApprovalActionError(response.status)
  }
  return body.receiptNonce
}

async function postDecision(url: string, init: RequestInit, fetcher: typeof fetch, retryAmbiguous: boolean): Promise<ApprovalActionResult> {
  const attempts = retryAmbiguous ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response
    try {
      response = await fetcher(url, init)
    } catch {
      if (attempt + 1 < attempts) continue
      throw new AgentApprovalActionError(0)
    }
    let body: unknown
    try {
      body = await response.json() as unknown
    } catch {
      if (retryAmbiguous && response.status === 202 && attempt + 1 < attempts) continue
      throw new AgentApprovalActionError(response.status)
    }
    if (!response.ok || response.status !== 202) throw new AgentApprovalActionError(response.status)
    if (!isRecord(body) || (body.disposition !== 'resolved' && body.disposition !== 'duplicate')) {
      if (attempt + 1 < attempts) continue
      throw new AgentApprovalActionError(response.status)
    }
    return { disposition: body.disposition }
  }
  throw new AgentApprovalActionError(0)
}

function isReviewedApplicationApproval(actionRef: ApprovalLedgerActionRef): boolean {
  return actionRef.action === 'review_application' && actionRef.approvalId === `reviewed-application-review:${actionRef.turnId}`
}

function isReceiptNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
