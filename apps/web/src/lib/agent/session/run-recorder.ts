import type { RunReport } from "@/lib/agent/types"
import type { Prisma, PrismaClient } from "@prisma/client"
import { createDualWriteSession, type DualWriteSession } from "./dual-write"
import {
  appendTranscriptEvent,
  completeSubAgentTask,
  createAgentSession,
  createSubAgentTask,
  updateAgentSession,
  type AgentSessionDb,
} from "./repository"
import type { AgentSessionStatus, SubAgentRole } from "./types"
import { mapPipelineEventToTranscript, messageBody, summarizeReport, textField } from "./pipeline-event-transcript"
export { mapPipelineEventToTranscript } from "./pipeline-event-transcript"
import { lockOpenSession, type V2TurnSource } from "./v2-turn"

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

type PipelineSubAgentRole = Exclude<SubAgentRole, "orchestrator">
const CLOSED_SESSION_STATUSES = ["aborted", "archived"] as const

type SessionLifecycleDb = AgentSessionDb & {
  agentSession: AgentSessionDb["agentSession"] & {
    findFirst(args: { where: { id: string; userId: string }; select: { id: true; status: true; controlGate: true } }): Promise<{ id: string; status: string; controlGate?: string } | null>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

type RecorderDb = AgentSessionDb & {
  $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>
}

async function withOpenSession<T>(
  db: AgentSessionDb,
  input: { sessionId: string; userId: string },
  work: (tx: AgentSessionDb) => Promise<T>,
): Promise<T> {
  const recorderDb = db as RecorderDb
  return recorderDb.$transaction(async tx => {
    await lockOpenSession(tx, input)
    return work(tx as unknown as AgentSessionDb)
  })
}

async function reopenExistingSession(db: AgentSessionDb, input: { sessionId: string; userId: string }): Promise<void> {
  const sessionDb = db as SessionLifecycleDb
  const session = await sessionDb.agentSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, status: true, controlGate: true },
  })
  if (!session || CLOSED_SESSION_STATUSES.includes(session.status as (typeof CLOSED_SESSION_STATUSES)[number]) || (session.controlGate !== undefined && session.controlGate !== "open")) {
    throw new Error(`Agent session ${input.sessionId} does not exist for this user`)
  }
  const updated = await sessionDb.agentSession.updateMany({
    where: { id: input.sessionId, userId: input.userId, controlGate: "open", status: { notIn: [...CLOSED_SESSION_STATUSES] } },
    data: { status: "running", completedAt: null },
  })
  if (updated.count !== 1) throw new Error(`Agent session ${input.sessionId} does not exist for this user`)
}

function roleFrom(data: unknown): PipelineSubAgentRole | null {
  const role = textField(data, "role")
  if (!role) return null
  const roles = ["scout", "analyst", "writer", "reviewer", "executor", "auditor"] as const
  return roles.includes(role as PipelineSubAgentRole) ? role as PipelineSubAgentRole : null
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
    await reopenExistingSession(db, { sessionId: session.id, userId: input.userId })
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
        const task = await withOpenSession(db, { sessionId: session.id, userId: input.userId }, async tx => {
          const created = await createSubAgentTask(tx, {
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
          await updateAgentSession(tx, {
            sessionId: session.id,
            currentTaskId: created.id,
          })
          return created
        })
        taskId = task.id
        taskIdsByRole.set(role, task.id)
      }

      if (event === "role_done" && role && taskId) {
        await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => completeSubAgentTask(tx, {
          taskId,
          status: "passed",
          result: payload,
          confidence: 1,
        }))
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
        : withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => appendTranscriptEvent(tx, transcript))
    },
    async finalize(finalizeInput: FinalizeInput) {
      if (dualWrite && input.manageV2Lifecycle !== false) {
        await dualWrite.finalize({
          status: finalizeInput.status,
          finalResponse: summarizeReport(finalizeInput.report),
          error: finalizeInput.status === "failed" ? summarizeReport(finalizeInput.report) : null,
        })
      }
      const result = await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => updateAgentSession(tx, {
        sessionId: session.id,
        status: finalizeInput.status,
        completedAt: new Date(),
        qualityScore: qualityScore(finalizeInput.report, finalizeInput.status),
        memorySummary: summarizeReport(finalizeInput.report),
      }))
      return result
    },
    async pause(message: string, role?: PipelineSubAgentRole) {
      const taskId = role ? taskIdsByRole.get(role) : undefined
      if (taskId) {
        await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => completeSubAgentTask(tx, {
          taskId,
          status: "waiting_for_user",
          failureReason: message,
        }))
      }
      if (dualWrite && input.manageV2Lifecycle !== false) await dualWrite.finalize({ status: "waiting_for_user", finalResponse: message })
      const result = await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => updateAgentSession(tx, {
        sessionId: session.id,
        status: "waiting_for_user",
        ...(taskId ? { currentTaskId: taskId } : {}),
        completedAt: null,
        memorySummary: message,
      }))
      return result
    },
  }

}
