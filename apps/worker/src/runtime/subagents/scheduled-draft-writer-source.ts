import type pg from "pg"

import { createArtifactToolStore, type ArtifactToolStore } from "../tools/artifact-tools.js"
import { PgArtifactToolStore } from "../tools/artifact-store-pg.js"
import type { AgentArtifactSourceDigestReader } from "../../db/agent-artifact-repo.js"
import { loadSelectedJobArtifactContext, type SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import { parseScheduledDraftCandidateWitness } from "./scheduled-draft-candidate-witness.js"
import { readCurrentScheduledDraftJobMaterialDigest, scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"

type Queryable = Pick<pg.Pool, "query">
type Row = Record<string, unknown>
type DraftMaterialAssertion = (client: Pick<pg.PoolClient, "query">, userId: string, jobId: string) => Promise<boolean>
export type SelectedJobArtifactContextForChild = Readonly<{
  context: SelectedJobArtifactContextBundle
  assertCurrentDraftMaterial?: DraftMaterialAssertion
}>

export function createArtifactToolStoreForChild(
  pool: pg.Pool,
  readCurrentSourceDigest: AgentArtifactSourceDigestReader,
  admission?: SelectedJobArtifactContextForChild,
): ArtifactToolStore {
  return admission?.assertCurrentDraftMaterial
    ? new PgArtifactToolStore(pool, readCurrentSourceDigest, admission.assertCurrentDraftMaterial)
    : createArtifactToolStore(pool, readCurrentSourceDigest)
}

/** Load only the exact selected Job source a scheduled Writer was admitted against. */
export async function loadSelectedJobArtifactContextForChild(
  pool: Queryable,
  userId: string,
  jobId: string,
  writerContext?: unknown,
): Promise<SelectedJobArtifactContextForChild | undefined> {
  const context = record(writerContext)
  const mode = context && Object.getOwnPropertyDescriptor(context, "scheduledDraftCandidateMode")
  const witnessValue = context && Object.getOwnPropertyDescriptor(context, "scheduledDraftCandidateWitness")
  if (!mode && !witnessValue) return { context: await loadSelectedJobArtifactContext(pool, userId, jobId) }
  if (!mode || !("value" in mode) || mode.value !== true || !witnessValue || !("value" in witnessValue)) return undefined
  const witness = parseScheduledDraftCandidateWitness(witnessValue.value)
  if (!witness || witness.candidate.jobId !== jobId) return undefined

  let source: SelectedJobArtifactContextBundle
  try { source = await loadSelectedJobArtifactContext(pool, userId, jobId) }
  catch { return undefined }
  if (witness.bindingVersion !== 2) return { context: source }
  const selectedJobs = source.transientSources.filter(item => item.sourceRef === `job:${jobId}`)
  if (selectedJobs.length !== 1 || scheduledDraftJobMaterialDigest(selectedJobs[0]?.content) !== witness.jobMaterialDigest) return undefined
  const assertCurrentDraftMaterial: DraftMaterialAssertion = async (client, currentUserId, currentJobId) => {
    if (currentUserId !== userId || currentJobId !== jobId) return false
    return await readCurrentScheduledDraftJobMaterialDigest(client, userId, jobId) === witness.jobMaterialDigest
  }
  return { context: source, assertCurrentDraftMaterial }
}

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : undefined
  } catch { return undefined }
}
