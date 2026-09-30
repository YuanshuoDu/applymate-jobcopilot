import type { RunReport } from "@/lib/agent/types"
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
import type { V2TurnSource } from "./v2-turn"
import { assertExistingSessionAvailable, createRunSessionActivation } from "./run-recorder-activation"
import { createRunRecorderWriteContext, withOpenSession, withRunRecorderTerminalOwnership, type RecorderFinalizationOwner } from "./run-recorder-ownership"

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
  /** Bind a raw legacy answer to the Turn created for its continuation. */
  legacyResumeQuestionId?: string
  /** Canonical TurnEngine owns the V2 terminal status for this run. */
  manageV2Lifecycle?: boolean
  /** Delay existing-session reopen and V2 projection until the execution is claimed. */
  deferActivation?: boolean
  /** Create or capture the exact canonical Turn without enabling transcript projection. */
  ensureTurn?: boolean
}
type FinalizeInput = { status: Extract<AgentSessionStatus, "completed" | "failed" | "aborted">; report: RunReport | null; owner?: RecorderFinalizationOwner }
type PipelineSubAgentRole = Exclude<SubAgentRole, "orchestrator">
function roleFrom(data: unknown): PipelineSubAgentRole | null {
  const role = textField(data, "role")
  return role && ["scout", "analyst", "writer", "reviewer", "executor", "auditor"].includes(role)
    ? role as PipelineSubAgentRole : null
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
      ...(input.deferActivation ? { status: "paused" as const } : {}),
    }) as { id: string }
  if (input.sessionId && input.deferActivation) {
    await assertExistingSessionAvailable(db, { sessionId: session.id, userId: input.userId })
  }
  const activation = createRunSessionActivation(db, {
    userId: input.userId,
    sessionId: session.id,
    goal: input.goal,
    source: input.source,
    turnId: input.turnId,
    legacyResumeQuestionId: input.legacyResumeQuestionId,
    dualWrite: Boolean(input.dualWrite),
    deferActivation: Boolean(input.deferActivation),
    reopenSession: Boolean(input.sessionId),
    ensureTurn: Boolean(input.ensureTurn),
  })
  if (!input.deferActivation) await activation.activate()
  const taskIdsByRole = new Map<PipelineSubAgentRole, string>()

  const { assertActivated, writeOwned } = createRunRecorderWriteContext({
    db, sessionId: session.id, userId: input.userId,
    isActivated: activation.isActivated, getWriteOwner: activation.getWriteOwner,
  })

  return {
    sessionId: session.id,
    activate: activation.activate,
    async record(event: string, payload: unknown) {
      assertActivated()
      const turn = activation.getDualWrite()
      const dualWrite = input.dualWrite ? turn : null
      const role = roleFrom(payload)
      let taskId: string | null = role ? taskIdsByRole.get(role) ?? null : null

      if (event === "role_start" && role) {
        const task = await writeOwned(async tx => {
          const created = await createSubAgentTask(tx, {
            sessionId: session.id,
            turnId: turn?.turnId ?? input.turnId,
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
        await writeOwned(tx => completeSubAgentTask(tx, {
          taskId,
          status: "passed",
          result: payload,
          confidence: 1,
        }))
      }

      const mapped = mapPipelineEventToTranscript(event, payload)
      if (!mapped) {
        if (!dualWrite) {
          await writeOwned(async () => null)
          return null
        }
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
        : writeOwned(tx => appendTranscriptEvent(tx, transcript))
    },
    getTurnId: () => activation.getDualWrite()?.turnId ?? input.turnId,
    async finalize(finalizeInput: FinalizeInput): Promise<boolean> {
      assertActivated()
      const dualWrite = activation.getDualWrite()
      if (finalizeInput.owner) {
        const owned = await withRunRecorderTerminalOwnership(db, {
          sessionId: session.id,
          userId: input.userId,
          owner: finalizeInput.owner,
          ...(input.manageV2Lifecycle !== false ? { v2Finalize: {
            status: finalizeInput.status === "aborted" ? "interrupted" : finalizeInput.status,
            finalResponse: summarizeReport(finalizeInput.report),
            error: finalizeInput.status === "failed" ? summarizeReport(finalizeInput.report) : null,
          } } : {}),
        }, tx => updateAgentSession(tx, {
          sessionId: session.id,
          status: finalizeInput.status,
          completedAt: new Date(),
          qualityScore: qualityScore(finalizeInput.report, finalizeInput.status),
          memorySummary: summarizeReport(finalizeInput.report),
        }).then(() => undefined))
        if (!owned) return false
        return true
      }
      if (dualWrite && input.manageV2Lifecycle !== false) {
        const terminalized = await dualWrite.finalize({
          status: finalizeInput.status,
          finalResponse: summarizeReport(finalizeInput.report),
          error: finalizeInput.status === "failed" ? summarizeReport(finalizeInput.report) : null,
        })
        if (!terminalized) return false
      }
      const result = await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => updateAgentSession(tx, {
        sessionId: session.id,
        status: finalizeInput.status,
        completedAt: new Date(),
        qualityScore: qualityScore(finalizeInput.report, finalizeInput.status),
        memorySummary: summarizeReport(finalizeInput.report),
      }))
      return Boolean(result)
    },
    async pause(message: string, role?: PipelineSubAgentRole, owner?: RecorderFinalizationOwner): Promise<boolean> {
      assertActivated()
      const dualWrite = activation.getDualWrite()
      const taskId = role ? taskIdsByRole.get(role) : undefined
      if (owner) {
        const owned = await withRunRecorderTerminalOwnership(db, {
          sessionId: session.id,
          userId: input.userId,
          owner,
          ...(input.manageV2Lifecycle !== false ? { v2Finalize: { status: "waiting_for_user", finalResponse: message, error: null } } : {}),
        }, async tx => {
          if (taskId) await completeSubAgentTask(tx, {
            taskId,
            status: "waiting_for_user",
            failureReason: message,
          })
          await updateAgentSession(tx, {
            sessionId: session.id,
            status: "waiting_for_user",
            ...(taskId ? { currentTaskId: taskId } : {}),
            completedAt: null,
            memorySummary: message,
          })
        })
        if (!owned) return false
        return true
      }
      if (taskId) {
        await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => completeSubAgentTask(tx, {
          taskId,
          status: "waiting_for_user",
          failureReason: message,
        }))
      }
      if (dualWrite && input.manageV2Lifecycle !== false) {
        const terminalized = await dualWrite.finalize({ status: "waiting_for_user", finalResponse: message })
        if (!terminalized) return false
      }
      const result = await withOpenSession(db, { sessionId: session.id, userId: input.userId }, tx => updateAgentSession(tx, {
        sessionId: session.id,
        status: "waiting_for_user",
        ...(taskId ? { currentTaskId: taskId } : {}),
        completedAt: null,
        memorySummary: message,
      }))
      return Boolean(result)
    },
  }

}
