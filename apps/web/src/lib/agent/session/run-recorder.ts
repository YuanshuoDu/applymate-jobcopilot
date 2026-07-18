import type { RunReport } from "@/lib/agent/types"
import {
  appendTranscriptEvent,
  completeSubAgentTask,
  createAgentSession,
  createSubAgentTask,
  updateAgentSession,
  type AgentSessionDb,
} from "./repository"
import type { AgentSessionStatus, SubAgentRole, TranscriptEventType } from "./types"

interface RunSessionRecorderInput {
  userId: string
  goal: string
  /** Bind a pipeline to an existing, already-authorized conversation. */
  sessionId?: string
}

interface FinalizeInput {
  status: Extract<AgentSessionStatus, "completed" | "failed" | "aborted">
  report: RunReport | null
}

interface TranscriptMapping {
  type: TranscriptEventType
  speaker: string
  title: string | null
  body: string
}

type PipelineSubAgentRole = Exclude<SubAgentRole, "orchestrator">

function textField(data: unknown, key: string) {
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

function roleFrom(data: unknown): PipelineSubAgentRole | null {
  const role = textField(data, "role")
  if (!role) return null
  const roles = ["scout", "analyst", "writer", "reviewer", "executor", "auditor"] as const
  return roles.includes(role as PipelineSubAgentRole) ? role as PipelineSubAgentRole : null
}

function messageBody(data: unknown, keys: string[], fallback: string) {
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

  if (event === "done") {
    return {
      type: "final_report",
      speaker: "Auditor",
      title: "Final Report",
      body: summarizeReport(data as Partial<RunReport>),
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

function summarizeReport(report: Partial<RunReport> | null) {
  if (!report) return "Agent run completed."
  return `Processed ${report.processed ?? 0} jobs · applied ${report.applied ?? 0} · pending ${report.pending ?? 0} · skipped ${report.skipped ?? 0} · failed ${report.failed ?? 0}`
}

function qualityScore(report: RunReport | null, status: AgentSessionStatus) {
  if (status !== "completed" || !report) return null
  if (report.processed <= 0) return 100
  return Math.max(0, Math.round(((report.processed - report.failed) / report.processed) * 100))
}

export async function createRunSessionRecorder(db: AgentSessionDb, input: RunSessionRecorderInput) {
  const session = input.sessionId
    ? { id: input.sessionId }
    : await createAgentSession(db, {
      userId: input.userId,
      goal: input.goal,
      source: "manual_run",
    }) as { id: string }
  if (input.sessionId) {
    await updateAgentSession(db, {
      sessionId: input.sessionId,
      status: "running",
      completedAt: null,
    })
  }
  const taskIdsByRole = new Map<PipelineSubAgentRole, string>()

  return {
    sessionId: session.id,
    async record(event: string, payload: unknown) {
      const role = roleFrom(payload)
      let taskId: string | null = role ? taskIdsByRole.get(role) ?? null : null

      if (event === "role_start" && role) {
        const task = await createSubAgentTask(db, {
          sessionId: session.id,
          role,
          taskType: "pipeline_stage",
          goal: messageBody(payload, ["plan", "message", "label"], `${role} pipeline stage`),
          constraints: ["Use the current pipeline context."],
          successCriteria: ["Return a structured stage summary."],
          allowedActions: ["read_context", "emit_progress"],
          context: payload,
          expectedOutputSchema: {
            type: "object",
            required: ["role", "summary"],
          },
        }) as { id: string }
        taskId = task.id
        taskIdsByRole.set(role, task.id)
        await updateAgentSession(db, {
          sessionId: session.id,
          currentTaskId: task.id,
        })
      }

      if (event === "role_done" && role && taskId) {
        await completeSubAgentTask(db, {
          taskId,
          status: "passed",
          result: payload,
          confidence: 1,
        })
      }

      const mapped = mapPipelineEventToTranscript(event, payload)
      if (!mapped) return null
      return appendTranscriptEvent(db, {
        sessionId: session.id,
        taskId,
        type: mapped.type,
        speaker: mapped.speaker,
        title: mapped.title,
        body: mapped.body,
        data: { event, payload },
      })
    },
    async finalize(input: FinalizeInput) {
      return updateAgentSession(db, {
        sessionId: session.id,
        status: input.status,
        completedAt: new Date(),
        qualityScore: qualityScore(input.report, input.status),
        memorySummary: summarizeReport(input.report),
      })
    },
  }
}
