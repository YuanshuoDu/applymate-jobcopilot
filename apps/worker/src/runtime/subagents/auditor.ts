import type { AgentEventRecord, RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"

import type { SubagentExecutionResult, SubagentTaskSpec } from "./types.js"

export type AuditorEvidenceQuery = {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId?: string
  readonly taskId?: string
}

export type AuditorArtifact = {
  readonly id: string
  readonly kind: string
  readonly hash: string
  readonly data: unknown
}

export type RedactedAuditorEvent = {
  readonly id: string
  readonly type: string
  readonly sequence: string
  readonly actor: AgentEventRecord["actor"]
  readonly createdAt: string
  readonly payload: RepositoryJsonValue
  readonly redacted: true
}

export type RedactedAuditorArtifact = {
  readonly id: string
  readonly kind: string
  readonly hash: string
  readonly data: RepositoryJsonValue
  readonly redacted: true
}

export interface AuditorEvidenceSource {
  readEvents(query: AuditorEvidenceQuery): Promise<readonly AgentEventRecord[]>
  readArtifacts?(query: AuditorEvidenceQuery): Promise<readonly AuditorArtifact[]>
}

export class RedactedAuditorReader {
  constructor(private readonly source: AuditorEvidenceSource) {}

  async readEvents(query: AuditorEvidenceQuery): Promise<readonly RedactedAuditorEvent[]> {
    const events = await this.source.readEvents(query)
    return events.map(event => ({
      id: event.id,
      type: event.type,
      sequence: event.sequence.toString(),
      actor: event.actor,
      createdAt: event.createdAt,
      payload: redactSensitiveValue(event.payload),
      redacted: true,
    }))
  }

  async readArtifacts(query: AuditorEvidenceQuery): Promise<readonly RedactedAuditorArtifact[]> {
    const artifacts = this.source.readArtifacts ? await this.source.readArtifacts(query) : []
    return artifacts.map(artifact => ({
      id: artifact.id,
      kind: artifact.kind,
      hash: artifact.hash,
      data: redactSensitiveValue(artifact.data),
      redacted: true,
    }))
  }

  async readAll(query: AuditorEvidenceQuery): Promise<{ events: readonly RedactedAuditorEvent[]; artifacts: readonly RedactedAuditorArtifact[] }> {
    const [events, artifacts] = await Promise.all([this.readEvents(query), this.readArtifacts(query)])
    return { events, artifacts }
  }
}

export function createAuditorTaskSpec(input: Omit<SubagentTaskSpec, "role" | "allowedActions" | "toolPolicySnapshot">): SubagentTaskSpec {
  return {
    ...input,
    role: "auditor",
    allowedActions: ["read_events", "read_artifacts", "produce_evidence_summary"],
    toolPolicySnapshot: { role: "auditor", mode: "read_only_evidence", externalWrites: false },
  }
}

export async function runAuditor(input: {
  readonly reader: RedactedAuditorReader
  readonly query: AuditorEvidenceQuery
}): Promise<SubagentExecutionResult> {
  return {
    status: "completed",
    result: {
      role: "auditor",
      mode: "read_only_evidence",
      redacted: true,
      evidence: await input.reader.readAll(input.query),
    },
  }
}
