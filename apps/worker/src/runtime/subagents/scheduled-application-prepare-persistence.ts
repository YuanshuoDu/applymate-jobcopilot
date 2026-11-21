import type pg from "pg"

import { createAgentArtifactRepository, type AgentArtifactBaseInsert, type AgentArtifactDraftWrite, type AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { withFencedArtifactWriteTransaction } from "../../db/agent-artifact-write-transaction.js"
import { loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import type { ScheduledPrepareArtifactWriteBinding, ScheduledPrepareJobInput } from "../tools/scheduled-application-prepare.js"

export type ScheduledPrepareMaterialSources = Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>

export function scheduledPrepareContainsRefs(sources: ScheduledPrepareMaterialSources, refs: readonly string[]): boolean {
  const approved = new Set(sources.preparation.evidenceRefs), available = new Set(sources.transientSources.map(source => source.sourceRef))
  return refs.length > 0 && new Set(refs).size === refs.length && refs.every(ref => approved.has(ref) && available.has(ref))
}

export function scheduledPrepareProvenanceRefs(sources: ScheduledPrepareMaterialSources, jobId: string, refs: readonly string[]): boolean {
  const required = ["job:" + jobId, "resume:" + sources.baseResumeId], persona = refs.filter(ref => ref.startsWith("persona:"))
  const expected = [...required, ...persona].sort()
  return refs.length === expected.length && refs.every((ref, index) => ref === expected[index]) && scheduledPrepareContainsRefs(sources, refs)
}

/** Persists scheduled Prepare source and draft rows under the shared source and job fences. */
export async function persistScheduledPrepareMaterial(pool: pg.Pool, input: ScheduledPrepareJobInput, kind: "resume" | "cover_letter",
  content: unknown, sources: ScheduledPrepareMaterialSources, usedRefs?: readonly string[]) {
  const binding: ScheduledPrepareArtifactWriteBinding = input.artifactBinding(kind)
  const provenanceRefs = usedRefs ?? binding.evidenceRefs
  if (sources.preparation.sourceDigest !== binding.sourceDigest
    || !scheduledPrepareProvenanceRefs(sources, binding.jobId, provenanceRefs)) {
    throw new Error("scheduled_prepare_source_changed")
  }
  const baseContent = kind === "resume" ? sourceContent(sources, "resume:" + sources.baseResumeId)
    : { kind: "scheduled_cover_letter_base", jobId: binding.jobId, sourceResumeId: sources.baseResumeId, sourceDigest: binding.sourceDigest }
  if (baseContent === undefined) throw new Error("scheduled_prepare_base_missing")
  const identity = scheduledPrepareArtifactIdentity(binding, input.invocation.owner.rootAttemptCount, provenanceRefs)
  const hash = hashArtifactContent(baseContent)
  const base: AgentArtifactBaseInsert = { id: identity.baseId, userId: binding.userId, jobId: binding.jobId, artifactType: kind, content: baseContent,
    hash, constraintHash: identity.baseConstraintHash, provenanceRefs: [...provenanceRefs], evidenceRefs: [...provenanceRefs] }
  const taskFence: AgentArtifactTaskFence = { ...binding.taskFence, taskFenceMode: "scheduled_prepare",
    turnLeaseOwnerId: input.invocation.owner.turnLeaseOwnerId, turnLeaseVersion: input.invocation.owner.turnLeaseVersion }
  const repository = createAgentArtifactRepository(pool)
  const write: AgentArtifactDraftWrite = { id: identity.draftId, userId: binding.userId, sessionId: binding.sessionId, jobId: binding.jobId,
    artifactType: kind, content, hash: hashArtifactContent(content), constraintHash: identity.constraintHash, provenanceRefs: [...provenanceRefs],
    evidenceRefs: [...provenanceRefs], baseId: identity.baseId, baseHash: hash, previousHash: null, sourceDigest: binding.sourceDigest,
    taskId: binding.taskFence.taskId, toolCallId: identity.toolCallId, requestHash: binding.requestHash, taskFence }
  const row = await withFencedArtifactWriteTransaction(pool, binding.userId, binding.jobId, async client => {
    const current = await loadSelectedJobArtifactContext(client, binding.userId, binding.jobId)
    if (current.preparation.sourceDigest !== binding.sourceDigest
      || !scheduledPrepareProvenanceRefs(current, binding.jobId, provenanceRefs)) {
      throw new Error("scheduled_prepare_source_changed")
    }
    await repository.insertBaseWithClient(client, base, taskFence)
    return repository.saveDraft(write, client)
  })
  return { artifactId: row.artifactId, version: row.version, contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

export function scheduledPrepareArtifactIdentity(binding: ScheduledPrepareArtifactWriteBinding, rootAttemptCount: number,
  usedRefs: readonly string[] = binding.evidenceRefs) {
  const sourceIdentity = { schemaVersion: "agent-harness.v2.scheduled-prepare-source-artifact.v1", kind: binding.kind,
    userId: binding.userId, jobId: binding.jobId, sourceDigest: binding.sourceDigest, evidenceRefs: usedRefs }
  const baseDigest = hashArtifactContent(sourceIdentity)
  const executionDigest = hashArtifactContent({ schemaVersion: "agent-harness.v2.scheduled-prepare-material.v1",
    userId: binding.userId, sessionId: binding.sessionId, turnId: binding.turnId, rootTaskId: binding.rootTaskId, rootAttemptCount,
    taskId: binding.taskId, executionId: binding.executionId, executionAttemptCount: binding.executionAttemptCount,
    sourceDigest: binding.sourceDigest, jobId: binding.jobId, kind: binding.kind, toolCallId: binding.toolCallId })
  return {
    baseId: "scheduled-base:" + baseDigest.slice(7), baseConstraintHash: baseDigest,
    draftId: "scheduled-draft:" + executionDigest.slice(7), toolCallId: "scheduled-prepare:" + executionDigest.slice(7),
    constraintHash: hashArtifactContent({ kind: binding.kind, score: binding.score, checkpointDigest: binding.checkpointDigest,
      choiceDigest: binding.resumeTailoringChoiceDigest, evidenceRefs: usedRefs }),
  }
}

function sourceContent(sources: ScheduledPrepareMaterialSources, ref: string): unknown {
  const matches = sources.transientSources.filter(source => source.sourceRef === ref)
  return matches.length === 1 ? matches[0]!.content : undefined
}
