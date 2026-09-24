import { schemaVersion } from './version.js'

export const AGENT_STREAM_SCHEMA_VERSION = schemaVersion
export const AGENT_DELTA_STREAM_MAX_LENGTH = 2_000

export type AgentStreamEnvelope = {
  schemaVersion: typeof schemaVersion
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  sequence: string | null
  payload: unknown
}

export type AgentDeltaEnvelope = AgentStreamEnvelope & {
  kind: 'delta' | 'snapshot'
  baseRevision: number
  revision: number
}

export function agentEventChannel(sessionId: string): string {
  return `agent:session:${sessionId}:events`
}

export function agentDeltaStream(sessionId: string): string {
  return `agent:session:${sessionId}:deltas`
}

export function agentDeltaChannel(sessionId: string): string {
  return `agent:session:${sessionId}:delta-notify`
}

export function createDurableEnvelope(input: Omit<AgentStreamEnvelope, 'schemaVersion'>): AgentStreamEnvelope {
  return { schemaVersion, ...input }
}

export function createDeltaEnvelope(input: Omit<AgentDeltaEnvelope, 'schemaVersion'>): AgentDeltaEnvelope {
  return { schemaVersion, ...input }
}
