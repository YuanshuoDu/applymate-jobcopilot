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
    const response = await fetcher(
      `/api/agent/sessions/${encodeURIComponent(request.sessionId)}/approvals/${encodeURIComponent(request.actionRef.approvalId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
        body: JSON.stringify({
          clientMessageId: request.clientMessageId,
          expectedTurnId: request.actionRef.turnId,
          expectedRevision: request.expectedRevision,
          decision: request.decision,
        }),
      },
    )
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok || response.status !== 202) throw new AgentApprovalActionError(response.status)
    if (!isRecord(body) || (body.disposition !== 'resolved' && body.disposition !== 'duplicate')) throw new AgentApprovalActionError(response.status)
    return { disposition: body.disposition }
  } catch (error: unknown) {
    if (error instanceof AgentApprovalActionError) throw error
    throw new AgentApprovalActionError(0)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
