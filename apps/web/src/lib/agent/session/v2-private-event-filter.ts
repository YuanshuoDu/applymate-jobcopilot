import { isPrivateNativeVerificationEventType } from "./stream-redaction"

const PRIVATE_EVENT_TYPES = new Set([
  "agent.plan.reconciliation",
  "agent.plan.clarification",
  "agent.plan.denial_checkpoint",
  "agent.plan.scheduled_prepare_binding",
  "agent.plan.discovery_persona_snapshot",
  "agent.plan.discovery_persona_overflow",
  "agent.plan.root_task_history_session_authorization",
  "agent.plan.root_task_history_memory_snapshot",
  "agent.plan.root_task_history_chronology_witness",
])

export function isPrivateV2EventType(type: string): boolean {
  return isPrivateNativeVerificationEventType(type) || PRIVATE_EVENT_TYPES.has(type)
}
