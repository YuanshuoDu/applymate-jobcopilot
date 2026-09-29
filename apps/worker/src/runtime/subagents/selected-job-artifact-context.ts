import type pg from "pg"

import { createSelectedJobPreparation, type ArtifactSourceMaterial } from "../tools/artifact-tools.js"
import type { ArtifactToolRecord, ArtifactToolStore } from "../tools/artifact-tools.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import type { SelectedJobPreparationContext } from "../tools/types.js"
import { hashArtifactContent } from "./artifact-adapters.js"

export type CoverLetterBaseReference = Readonly<{ artifactId: string; baseHash: string }>

/** Re-load the selected job and approved profile sources under the current Worker tenant fence. */
export async function loadSelectedJobArtifactContext(
  pool: Pick<pg.Pool, "query">,
  userId: string,
  jobId: string,
): Promise<SelectedJobPreparationContext> {
  if (!userId.trim() || !jobId.trim()) throw new Error("selected_job_scope_invalid")
  const source = createPostgresReadToolDataSource(pool as pg.Pool)
  const job = await source.getJob(userId, jobId)
  if (!job) throw new Error("selected_job_not_found")
  const [resumeResult, personaResult] = await Promise.all([
    source.getBaseResume(userId, {}),
    source.retrievePersona(userId, { useCase: "cover_letter" }),
  ])
  const resume = resumeResult.resume
  if (!resume) throw new Error("selected_job_base_resume_missing")

  const materials: ArtifactSourceMaterial[] = [
    { sourceRef: `job:${job.id}`, content: job },
    { sourceRef: `resume:${resume.id}`, content: resume.content },
    ...personaResult.facts.map(fact => ({
      sourceRef: `persona:${fact.sourceRef ?? fact.id}`,
      content: { id: fact.id, key: fact.key, value: fact.value, confidence: fact.confidence },
    })),
  ]
  return createSelectedJobPreparation(jobId, materials)
}

/** Resolve or create one immutable, content-free base for the selected job. */
export async function resolveCoverLetterBase(
  store: ArtifactToolStore,
  userId: string,
  jobId: string,
): Promise<CoverLetterBaseReference> {
  const existing = await store.listForUser(userId, jobId)
  const base = existing.find(record => isCoverLetterBase(record))
  if (base) return { artifactId: base.id, baseHash: base.hash }
  const id = `cover-letter-base:${hashArtifactContent({ userId, jobId }).slice(7)}`
  try {
    const created = await store.registerBase({
      id, type: "cover_letter", userId, jobId,
      content: { kind: "cover_letter_base", jobId },
    })
    return { artifactId: created.id, baseHash: created.hash }
  } catch {
    const winner = (await store.listForUser(userId, jobId)).find(record => isCoverLetterBase(record))
    if (winner) return { artifactId: winner.id, baseHash: winner.hash }
    throw new Error("cover_letter_base_unavailable")
  }
}

function isCoverLetterBase(value: ArtifactToolRecord): boolean {
  return value.type === "cover_letter" && value.lifecycle === "base" && value.id.length > 0 && value.hash.length > 0
}
