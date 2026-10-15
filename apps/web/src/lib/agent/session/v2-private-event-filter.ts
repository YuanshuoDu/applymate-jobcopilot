import { isPrivateNativeVerificationEventType } from "./stream-redaction"

const PRIVATE_EVENT_TYPES = new Set(["agent.plan.reconciliation", "agent.plan.clarification"])

export function isPrivateV2EventType(type: string): boolean {
  return isPrivateNativeVerificationEventType(type) || PRIVATE_EVENT_TYPES.has(type)
}
