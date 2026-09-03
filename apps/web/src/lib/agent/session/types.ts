export type AgentSessionSource = "chat" | "automation" | "manual_run" | "system"

export type AgentSessionStatus =
  | "draft"
  | "running"
  | "waiting_for_user"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"

export type SubAgentRole =
  | "orchestrator"
  | "scout"
  | "analyst"
  | "writer"
  | "reviewer"
  | "executor"
  | "auditor"

export type SubAgentTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "closed"
  // Legacy rows and the pre-Harness UI use `passed` for completed work.
  | "passed"
  | "failed"
  | "retrying"
  | "waiting_for_user"
  | "skipped"

export type DurableSubAgentTaskStatus = Exclude<SubAgentTaskStatus, "passed">

export function toDurableSubAgentTaskStatus(status: SubAgentTaskStatus): DurableSubAgentTaskStatus {
  return status === "passed" ? "completed" : status
}

export function toLegacySubAgentTaskStatus(status: string): string {
  return status === "completed" ? "passed" : status
}

export type TranscriptEventType =
  | "user_message"
  | "orchestrator_plan"
  | "subagent_task_started"
  | "subagent_result"
  | "thinking_summary"
  | "quality_gate"
  | "approval_request"
  | "approval_response"
  | "automation_draft"
  | "automation_started"
  | "automation_created"
  | "automation_updated"
  | "automation_cancelled"
  | "job_results"
  | "application_queued"
  | "session_memory"
  | "final_report"
  | "error"

export interface QualityGateResult {
  gate: string
  status: "passed" | "failed" | "uncertain"
  score: number
  retryRecommended: boolean
  askUserRecommended: boolean
  hitMissReason: string
  evidence: string[]
}
