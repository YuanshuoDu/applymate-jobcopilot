import {
  appendTranscriptEvent,
  completeSubAgentTask,
  createSubAgentTask,
  updateAgentSession,
  type AgentSessionDb,
  type CreateSubAgentTaskInput,
} from "./repository"
import type { QualityGateResult } from "./types"

type JsonValue = unknown

export interface SubAgentTaskSuccess {
  result: JsonValue
  confidence: number
  summary: string
  qualityGateResult?: QualityGateResult | null
}

export interface SubAgentTaskRunResult {
  taskId: string
  status: "passed" | "failed"
  result: JsonValue | null
  confidence: number
  failureReason: string | null
}

function speakerFor(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function runSubAgentTask(
  db: AgentSessionDb,
  contract: CreateSubAgentTaskInput,
  handler: () => Promise<SubAgentTaskSuccess>,
): Promise<SubAgentTaskRunResult> {
  const task = await createSubAgentTask(db, contract) as { id: string }
  const speaker = speakerFor(contract.role)

  await updateAgentSession(db, {
    sessionId: contract.sessionId,
    currentTaskId: task.id,
  })
  await appendTranscriptEvent(db, {
    sessionId: contract.sessionId,
    taskId: task.id,
    type: "subagent_task_started",
    speaker,
    title: contract.taskType,
    body: contract.goal,
    data: { contract },
  })

  try {
    const output = await handler()
    await completeSubAgentTask(db, {
      taskId: task.id,
      status: "passed",
      result: output.result,
      confidence: output.confidence,
      qualityGateResult: output.qualityGateResult ?? null,
    })
    await appendTranscriptEvent(db, {
      sessionId: contract.sessionId,
      taskId: task.id,
      type: "subagent_result",
      speaker,
      title: "Task completed",
      body: output.summary,
      data: {
        result: output.result,
        confidence: output.confidence,
        qualityGateResult: output.qualityGateResult ?? null,
      },
    })
    return {
      taskId: task.id,
      status: "passed",
      result: output.result,
      confidence: output.confidence,
      failureReason: null,
    }
  } catch (error) {
    const reason = errorMessage(error)
    await completeSubAgentTask(db, {
      taskId: task.id,
      status: "failed",
      result: null,
      confidence: 0,
      failureReason: reason,
    })
    await appendTranscriptEvent(db, {
      sessionId: contract.sessionId,
      taskId: task.id,
      type: "error",
      speaker,
      title: "Task failed",
      body: reason,
      data: { failureReason: reason },
    })
    return {
      taskId: task.id,
      status: "failed",
      result: null,
      confidence: 0,
      failureReason: reason,
    }
  }
}
