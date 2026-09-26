import type { RunReport } from '@/lib/agent/types'
import type { TranscriptEventType } from './types'

export interface TranscriptMapping {
  type: TranscriptEventType
  speaker: string
  title: string | null
  body: string
}
export function textField(data: unknown, key: string) {
  if (!data || typeof data !== "object") return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberField(data: unknown, key: string) {
  if (!data || typeof data !== "object") return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function roleSpeaker(data: unknown, fallback = "Agent") {
  const role = textField(data, "role")
  if (!role) return fallback
  return role.slice(0, 1).toUpperCase() + role.slice(1)
}

export function messageBody(data: unknown, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = textField(data, key)
    if (value) return value
  }
  return fallback
}

export function mapPipelineEventToTranscript(event: string, data: unknown): TranscriptMapping | null {
  if (event === "orchestrator_plan") {
    return {
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: messageBody(data, ["plan", "message"], "Orchestrator created a plan."),
    }
  }

  if (event === "orchestrator_question") {
    return {
      type: "approval_request",
      speaker: "Orchestrator",
      title: "Approval Required",
      body: messageBody(data, ["question", "message"], "Orchestrator needs your decision."),
    }
  }

  if (event === "application_review_ready") {
    const approval = data && typeof data === "object"
      ? (data as { approval?: { title?: string; body?: string } }).approval
      : undefined
    return {
      type: "approval_request",
      speaker: "Reviewer",
      title: approval?.title ?? "Application review required",
      body: approval?.body ?? "Review this application before requesting submission authorization.",
    }
  }

  if (event === "artifact_created" || event === "artifact_reviewed") {
    const record = data && typeof data === "object" ? data as { artifact?: { artifactId?: unknown; artifactType?: unknown; version?: unknown; hash?: unknown }; artifacts?: Array<{ artifactId?: unknown; artifactType?: unknown; version?: unknown; hash?: unknown }>; reviews?: Array<{ artifact?: { artifactId?: unknown; artifactType?: unknown; version?: unknown; hash?: unknown } }>; status?: unknown } : {}
    const artifact = record.artifact ?? record.reviews?.[0]?.artifact ?? record.artifacts?.[0]
    const id = typeof artifact?.artifactId === "string" ? artifact.artifactId : "artifact"
    const kind = typeof artifact?.artifactType === "string" ? artifact.artifactType : "material"
    const version = typeof artifact?.version === "number" ? ` v${artifact.version}` : ""
    const hash = typeof artifact?.hash === "string" ? ` (${artifact.hash.slice(0, 19)}…)` : ""
    return {
      type: "quality_gate",
      speaker: roleSpeaker(data, event === "artifact_created" ? "Writer" : "Reviewer"),
      title: event === "artifact_created" ? "Artifact draft" : "Artifact review",
      body: `${kind} ${id}${version}${hash}${record.status ? ` · ${String(record.status)}` : ""}`,
    }
  }

  if (event === "agent_plan") {
    return {
      type: "orchestrator_plan",
      speaker: roleSpeaker(data),
      title: "Plan",
      body: messageBody(data, ["plan", "message"], "Agent created a plan."),
    }
  }

  if (event === "agent_action" || event === "agent_observation") {
    return {
      type: "subagent_result",
      speaker: roleSpeaker(data),
      title: event === "agent_action" ? "Action" : "Observation",
      body: messageBody(data, ["action", "observation", "message"], "Agent produced an update."),
    }
  }

  if (event === "agent_reflect") {
    return {
      type: "thinking_summary",
      speaker: roleSpeaker(data),
      title: "Thinking Summary",
      body: messageBody(data, ["reflect", "message"], "Agent reflected on the task."),
    }
  }

  if (event === "job_done") {
    const company = textField(data, "company") ?? "Unknown company"
    const role = textField(data, "role") ?? "Unknown role"
    const score = numberField(data, "score")
    return {
      type: "job_results",
      speaker: "Analyst",
      title: "Job Result",
      body: `${company} · ${role}${score === null ? "" : ` — ${score}%`}`,
    }
  }

  if (event === "application_queued") {
    const company = textField(data, "company") ?? "Application"
    const role = textField(data, "role") ?? ""
    return {
      type: "application_queued",
      speaker: "Executor",
      title: "Unattended submission queued",
      body: `${company}${role ? ` · ${role}` : ""} is queued for background submission.`,
    }
  }

  if (event === "custom_agent_result") {
    const row = data && typeof data === "object" ? data as { agentName?: unknown; observations?: unknown[] } : {}
    const agentName = typeof row.agentName === "string" ? row.agentName : "Custom agent"
    const count = Array.isArray(row.observations) ? row.observations.length : 0
    return {
      type: "subagent_result",
      speaker: agentName,
      title: "Structured findings",
      body: `${count} structured job finding${count === 1 ? "" : "s"} recorded for the final review.`,
    }
  }

  if (event === "custom_agent_summary") {
    const row = data && typeof data === "object" ? data as { findings?: unknown[] } : {}
    const count = Array.isArray(row.findings) ? row.findings.length : 0
    return {
      type: "thinking_summary",
      speaker: "Orchestrator",
      title: "Custom-agent summary",
      body: `${count} de-duplicated custom-agent finding${count === 1 ? "" : "s"} included in the final audit.`,
    }
  }

  if (event === "done") {
    return {
      type: "final_report",
      speaker: "Auditor",
      title: "Final Report",
      body: summarizeReport(data as Partial<RunReport>),
    }
  }

  if (event === "pipeline_checkpoint") {
    return {
      type: "thinking_summary",
      speaker: "Orchestrator",
      title: "Pipeline checkpoint",
      body: messageBody(data, ["nextStage"], "Pipeline checkpoint persisted."),
    }
  }

  if (event === "error") {
    return {
      type: "error",
      speaker: "System",
      title: "Error",
      body: messageBody(data, ["message", "error"], "Agent run failed."),
    }
  }

  if (event === "info" || event === "start" || event === "role_start" || event === "role_done") {
    return {
      type: event === "role_start" ? "subagent_task_started" : "subagent_result",
      speaker: roleSpeaker(data, event === "info" ? "System" : "Agent"),
      title: event.replace(/_/g, " "),
      body: messageBody(data, ["message", "summary", "label"], event),
    }
  }

  return null
}

export function summarizeReport(report: Partial<RunReport> | null) {
  if (!report) return "Agent run completed."
  return `Processed ${report.processed ?? 0} jobs · dispatched ${report.queued ?? 0} · confirmed ${report.applied ?? 0} · pending ${report.pending ?? 0} · skipped ${report.skipped ?? 0} · failed ${report.failed ?? 0}`
}
