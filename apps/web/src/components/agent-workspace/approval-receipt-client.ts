import type { TranscriptAction } from "./TranscriptSpecialBlocks"

export async function ensureActionReceipt(sessionId: string, action: TranscriptAction): Promise<TranscriptAction> {
  const needsReceipt = action.type === "create_automation"
    || (action.type === "approval_response" && action.decision === "approved")
  if (!needsReceipt || action.receiptNonce || !action.approvalId) return action

  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(action.approvalId)}`)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { receiptNonce?: unknown }
  if (typeof payload.receiptNonce !== "string" || !payload.receiptNonce) throw new Error("The approval receipt could not be refreshed")
  return { ...action, receiptNonce: payload.receiptNonce }
}

async function responseError(response: Response): Promise<string> {
  const fallback = `Approval receipt refresh failed (${response.status})`
  const raw = await response.text().catch(() => "")
  if (!raw) return fallback
  try {
    const data = JSON.parse(raw) as { error?: unknown }
    return typeof data.error === "string" && data.error.trim() ? data.error : fallback
  } catch {
    return fallback
  }
}
