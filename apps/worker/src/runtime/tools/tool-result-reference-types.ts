import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export const MAX_TOOL_RESULT_BYTES = 1024 * 1024
export const MAX_TOOL_RESULT_READ_BYTES = 4096

export type ToolResultReferenceRecord = {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId: string
  readonly toolCallId: string
  readonly sanitizedJson: RepositoryJsonValue
  readonly sha256: string
  readonly byteCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type PutToolResultInput = {
  readonly stepId: string
  readonly toolCallId: string
  readonly value: unknown
  readonly now?: Date
}

export type ToolResultReadInput = {
  readonly referenceId: string
  readonly cursor?: string
}

export type ToolResultReadScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
}

export type ToolResultChunk = {
  readonly ref: string
  readonly sha256: string
  readonly byteCount: number
  readonly chunk: string
  readonly nextCursor: string | null
}

export interface ToolResultReferenceRepository {
  put(owner: import("../execution-owner.js").ExecutionOwner, input: PutToolResultInput): Promise<ToolResultReferenceRecord>
  read(owner: import("../execution-owner.js").ExecutionOwner, input: ToolResultReadInput): Promise<ToolResultChunk | null>
}
