import type { Actor } from "@jobcopilot/agent-protocol"

import type { AppendTranscriptEventInput } from "./repository"

export type V2ItemStatus = "started" | "streaming" | "completed" | "failed" | "interrupted"
export type V2ItemPhase = "commentary" | "final_answer" | null

export interface LegacyV2Mapping {
  eventType: string
  actor: Actor
  itemType: string
  itemStatus: V2ItemStatus
  phase: V2ItemPhase
  opaque: boolean
}

const PIPELINE_EVENTS = new Set([
  "orchestrator_plan",
  "orchestrator_question",
  "application_review_ready",
  "agent_plan",
  "agent_action",
  "agent_observation",
  "agent_reflect",
  "job_done",
  "application_queued",
  "custom_agent_result",
  "custom_agent_summary",
  "done",
  "error",
  "info",
  "start",
  "role_start",
  "role_done",
  "pipeline_checkpoint",
])

const TRANSCRIPT_EVENT_MAP: Record<string, Omit<LegacyV2Mapping, "opaque">> = {
  user_message: { eventType: "input.accepted", actor: "user", itemType: "user_message", itemStatus: "completed", phase: "commentary" },
  orchestrator_plan: { eventType: "item.completed", actor: "orchestrator", itemType: "plan", itemStatus: "completed", phase: "commentary" },
  subagent_task_started: { eventType: "item.started", actor: "subagent", itemType: "subagent_activity", itemStatus: "started", phase: "commentary" },
  subagent_result: { eventType: "item.completed", actor: "subagent", itemType: "subagent_activity", itemStatus: "completed", phase: "commentary" },
  thinking_summary: { eventType: "item.completed", actor: "subagent", itemType: "reasoning_summary", itemStatus: "completed", phase: "commentary" },
  quality_gate: { eventType: "item.completed", actor: "orchestrator", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  approval_request: { eventType: "approval.requested", actor: "orchestrator", itemType: "approval_request", itemStatus: "completed", phase: "commentary" },
  approval_response: { eventType: "approval.resolved", actor: "user", itemType: "approval_response", itemStatus: "completed", phase: "commentary" },
  automation_draft: { eventType: "item.completed", actor: "orchestrator", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  automation_started: { eventType: "item.started", actor: "system", itemType: "subagent_activity", itemStatus: "started", phase: "commentary" },
  automation_created: { eventType: "item.completed", actor: "system", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  automation_updated: { eventType: "item.completed", actor: "system", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  automation_cancelled: { eventType: "item.completed", actor: "user", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  job_results: { eventType: "item.completed", actor: "subagent", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  application_queued: { eventType: "item.completed", actor: "subagent", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
  session_memory: { eventType: "item.completed", actor: "system", itemType: "context_compaction", itemStatus: "completed", phase: "commentary" },
  final_report: { eventType: "turn.completed", actor: "orchestrator", itemType: "artifact", itemStatus: "completed", phase: "final_answer" },
  error: { eventType: "item.failed", actor: "system", itemType: "error", itemStatus: "failed", phase: "commentary" },
  pipeline_checkpoint: { eventType: "step.completed", actor: "orchestrator", itemType: "artifact", itemStatus: "completed", phase: "commentary" },
}

function actorFromSpeaker(speaker: string): Actor {
  const normalized = speaker.toLowerCase()
  if (normalized === "you" || normalized === "user") return "user"
  if (normalized === "system") return "system"
  if (normalized === "tool") return "tool"
  if (normalized === "orchestrator") return "orchestrator"
  return "subagent"
}

/**
 * Keeps the old transcript vocabulary as the compatibility boundary. Unknown
 * pipeline events are intentionally represented as opaque facts instead of
 * being silently discarded by the legacy mapper.
 */
export function mapLegacyTranscriptToV2(
  input: Pick<AppendTranscriptEventInput, "type" | "speaker">,
  sourceEvent?: string,
): LegacyV2Mapping {
  const knownPipelineEvent = !sourceEvent || PIPELINE_EVENTS.has(sourceEvent) || sourceEvent === input.type
  const mapped = TRANSCRIPT_EVENT_MAP[input.type]
  if (knownPipelineEvent && mapped) return { ...mapped, opaque: false }

  return {
    eventType: "legacy.opaque",
    actor: actorFromSpeaker(input.speaker),
    itemType: "artifact",
    itemStatus: "completed",
    phase: "commentary",
    opaque: true,
  }
}

export function isKnownPipelineEvent(event: string) {
  return PIPELINE_EVENTS.has(event)
}

export function legacyV2MappingTable() {
  return Object.fromEntries(Object.entries(TRANSCRIPT_EVENT_MAP).map(([key, value]) => [key, { ...value, opaque: false }]))
}
