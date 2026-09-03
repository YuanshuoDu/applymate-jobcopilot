import { toLegacySubAgentTaskStatus } from "./types"

export interface LegacySubAgentTaskProjection {
  id: string
  sessionId: string
  role: string
  taskType: string
  status: string
  goal: string
  confidence: number | null
  failureReason: string | null
  hasResult: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * Projects durable task rows into the old task-list contract. The durable
 * store calls successful work `completed`; old clients continue to see `passed`.
 */
export function projectLegacySubAgentTask(row: {
  id: string
  sessionId: string
  role: string
  taskType: string
  status: string
  goal: string
  confidence: number | null
  failureReason: string | null
  result: unknown | null
  createdAt: Date
  updatedAt: Date
}): LegacySubAgentTaskProjection {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    taskType: row.taskType,
    status: toLegacySubAgentTaskStatus(row.status),
    goal: row.goal,
    confidence: row.confidence,
    failureReason: row.failureReason,
    hasResult: row.result !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
