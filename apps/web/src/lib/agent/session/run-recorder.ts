import type { RunReport } from "@/lib/agent/types"
import type { PrismaClient } from "@prisma/client"
import { createDualWriteSession, type DualWriteSession } from "./dual-write"
import {
  appendTranscriptEvent,
  completeSubAgentTask,
  createAgentSession,
  createSubAgentTask,
  updateAgentSession,
  type AgentSessionDb,
} from "./repository"
import type { AgentSessionStatus, SubAgentRole, TranscriptEventType } from "./types"
import type { V2TurnSource } from "./v2-turn"

interface RunSessionRecorderInput {
  userId: string
  goal: string
  /** Bind a pipeline to an existing, already-authorized conversation. */
  sessionId?: string
  /** Enable the shadow V2 projection without changing legacy behavior when off. */
  dualWrite?: boolean
  source?: V2TurnSource
  /** Bind the recorder to the canonical Turn created for this automation run. */
  turnId?: string
  /** Canonical TurnEngine owns the V2 terminal status for this run. */
  manageV2Lifecycle?: boolean
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

function summarizeReport(report: Partial<RunReport> | null) {
  if (!report) return "Agent run completed."
  return `Processed ${report.processed ?? 0} jobs · dispatched ${report.queued ?? 0} · confirmed ${report.applied ?? 0} · pending ${report.pending ?? 0} · skipped ${report.skipped ?? 0} · failed ${report.failed ?? 0}`
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
  const dualWrite: DualWriteSession | null = input.dualWrite
    ? await createDualWriteSession(db as unknown as PrismaClient, {
      sessionId: session.id,
      userId: input.userId,
      goal: input.goal,
      source: input.source ?? "system",
      turnId: input.turnId,
    })
    : null
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
      if (!mapped) {
        if (!dualWrite) return null
        return dualWrite.record({
          sessionId: session.id,
          taskId,
          type: "error",
          speaker: "System",
          title: "Opaque agent event",
          body: `Preserved an unrecognized pipeline event: ${event}`,
          data: { opaque: true, event, payload },
        }, { name: event, payload })
      }
      const transcript = {
        sessionId: session.id,
        taskId,
        type: mapped.type,
        speaker: mapped.speaker,
        title: mapped.title,
        body: mapped.body,
        data: { event, payload },
      }
      return dualWrite
        ? dualWrite.record(transcript, { name: event, payload })
        : appendTranscriptEvent(db, transcript)
    },
    async finalize(finalizeInput: FinalizeInput) {
      const result = await updateAgentSession(db, {
        sessionId: session.id,
        status: finalizeInput.status,
        completedAt: new Date(),
        qualityScore: qualityScore(finalizeInput.report, finalizeInput.status),
        memorySummary: summarizeReport(finalizeInput.report),
      })
      if (dualWrite && input.manageV2Lifecycle !== false) {
        await dualWrite.finalize({
          status: finalizeInput.status,
          finalResponse: summarizeReport(finalizeInput.report),
          error: finalizeInput.status === "failed" ? summarizeReport(finalizeInput.report) : null,
        })
      }
      return result
    },
    async pause(message: string, role?: PipelineSubAgentRole) {
      const taskId = role ? taskIdsByRole.get(role) : undefined
      if (taskId) {
        await completeSubAgentTask(db, {
          taskId,
          status: "waiting_for_user",
          failureReason: message,
        })
      }
      const result = await updateAgentSession(db, {
        sessionId: session.id,
        status: "waiting_for_user",
        ...(taskId ? { currentTaskId: taskId } : {}),
        completedAt: null,
        memorySummary: message,
      })
      if (dualWrite && input.manageV2Lifecycle !== false) await dualWrite.finalize({ status: "waiting_for_user", finalResponse: message })
      return result
    },
  }

}
