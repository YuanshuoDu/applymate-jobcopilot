import type { PoolClient } from "pg"
import {
  buildObjectiveApplicationResumeWitness,
  type ObjectiveApplicationResumeMaterial,
  type ObjectiveApplicationResumeWitness,
} from "@jobcopilot/shared"

export type ObjectiveApplicationResumeWitnessScope = Readonly<{ userId: string; jobId: string }>
export type ObjectiveApplicationResumeMaterialRead = Readonly<{
  witness: ObjectiveApplicationResumeWitness
  resumeContent: unknown
}>

type ResumeRow = Readonly<{
  jobId: string; userId: string; finalResumeId: string | null; finalResumeAssignmentRevision: number
  resumeId: string; resumeUserId: string; name: string; content: unknown; templateId: string | null
  templateOptions: unknown | null; kind: string; targetJobId: string | null; parentResumeId: string | null
  basicsDetached: boolean; materialRevision: number
}>

/** Reads the assigned adapted Resume on the caller's source-fenced transaction client. */
export async function readObjectiveApplicationResumeWitness(
  client: Pick<PoolClient, "query">,
  scope: ObjectiveApplicationResumeWitnessScope,
): Promise<ObjectiveApplicationResumeWitness | null> {
  return (await readObjectiveApplicationResumeMaterial(client, scope))?.witness ?? null
}

/** Reads content and its revision/hash witness from the same exact Job-to-Resume row. */
export async function readObjectiveApplicationResumeMaterial(
  client: Pick<PoolClient, "query">,
  scope: ObjectiveApplicationResumeWitnessScope,
): Promise<ObjectiveApplicationResumeMaterialRead | null> {
  if (!validScope(scope)) return null
  const result = await client.query<ResumeRow>(`
    SELECT job."id" AS "jobId", job."userId", job."finalResumeId",
      job."finalResumeAssignmentRevision", resume."id" AS "resumeId",
      resume."userId" AS "resumeUserId", resume."name", resume."content",
      resume."templateId", resume."templateOptions", resume."kind", resume."targetJobId",
      resume."parentResumeId", resume."basicsDetached", resume."materialRevision"
    FROM "Job" AS job
    INNER JOIN "Resume" AS resume
      ON resume."id" = job."finalResumeId" AND resume."userId" = job."userId"
      AND resume."targetJobId" = job."id" AND resume."kind" = 'adapted'
    WHERE job."id" = $1 AND job."userId" = $2
    FOR SHARE OF job, resume`, [scope.jobId, scope.userId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  if (!row || row.jobId !== scope.jobId || row.userId !== scope.userId
    || typeof row.finalResumeId !== "string" || row.resumeId !== row.finalResumeId
    || row.resumeUserId !== scope.userId || row.targetJobId !== scope.jobId || row.kind !== "adapted"
    || typeof row.name !== "string" || !nullableString(row.templateId) || !nullableString(row.parentResumeId)
    || !nullableString(row.targetJobId) || typeof row.basicsDetached !== "boolean"
    || !revision(row.finalResumeAssignmentRevision) || !revision(row.materialRevision)) return null
  const material: ObjectiveApplicationResumeMaterial = {
    name: row.name, content: row.content, templateId: row.templateId, templateOptions: row.templateOptions,
    kind: row.kind, targetJobId: row.targetJobId, parentResumeId: row.parentResumeId, basicsDetached: row.basicsDetached,
  }
  const witness = buildObjectiveApplicationResumeWitness({
    userId: scope.userId, jobId: scope.jobId, resumeId: row.resumeId,
    finalResumeAssignmentRevision: row.finalResumeAssignmentRevision, materialRevision: row.materialRevision, material,
  })
  return witness && plainResumeContent(row.content) ? { witness, resumeContent: row.content } : null
}

function validScope(value: unknown): value is ObjectiveApplicationResumeWitnessScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return boundedId(scope.userId) && boundedId(scope.jobId)
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function plainResumeContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null }
  catch { return false }
}
