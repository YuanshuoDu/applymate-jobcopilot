import type pg from "pg"

import { createSelectedJobPreparation, type ArtifactSourceMaterial } from "../tools/artifact-tools.js"
import type { ArtifactToolRecord, ArtifactToolStore } from "../tools/artifact-tools.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import type { SelectedJobPreparationContext } from "../tools/types.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import type { StructuredRoleResult } from "./role-results.js"

export type CoverLetterBaseReference = Readonly<{ artifactId: string; baseHash: string }>
export type SelectedJobArtifactContextBundle = Readonly<{
  preparation: SelectedJobPreparationContext
  baseResumeId: string
  transientSources: readonly ArtifactSourceMaterial[]
}>

const SELECTED_JOB_READ_TOOLS = new Set(["jobs.get", "persona.retrieve", "resume.get_base"])
const SELECTED_JOB_PRIVATE_PLACEHOLDER = "[Private selected-job response withheld]"

export function isSelectedJobReadTool(toolName: string): boolean { return SELECTED_JOB_READ_TOOLS.has(toolName) }

export function selectedJobToolAllowed(role: string, toolName: string): boolean {
  if (role === "scout") return toolName === "jobs.get"
  if (role === "analyst") return SELECTED_JOB_READ_TOOLS.has(toolName)
  if (role === "writer") return toolName === "cover_letter.draft"
  return role === "reviewer" && (toolName === "artifact.version.read" || toolName === "artifact.review")
}

export function hasSelectedJobReadContext(context: SelectedJobArtifactContextBundle | undefined, jobId: string): boolean {
  if (!context) return false
  const preparation = context.preparation
  return Boolean(preparation.jobId === jobId && /^sha256:[a-f0-9]{64}$/.test(preparation.sourceDigest)
    && Array.isArray(preparation.evidenceRefs) && preparation.evidenceRefs.length > 0
    && preparation.evidenceRefs.every(ref => typeof ref === "string" && ref.trim().length > 0 && ref.length <= 256)
    && new Set(preparation.evidenceRefs).size === preparation.evidenceRefs.length
    && typeof context.baseResumeId === "string" && context.baseResumeId.trim().length > 0
    && Array.isArray(context.transientSources) && context.transientSources.length > 0)
}

/** Bind selected-mode read inputs to the server-loaded job, base resume, and use case. */
export function bindSelectedJobReadInput(
  toolName: string,
  input: unknown,
  context: Pick<SelectedJobArtifactContextBundle, "preparation" | "baseResumeId">,
): unknown | undefined {
  const modelInput = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  if (toolName === "jobs.get") return { jobId: context.preparation.jobId }
  if (toolName === "persona.retrieve") {
    return {
      ...(Object.prototype.hasOwnProperty.call(modelInput, "keys") ? { keys: modelInput.keys } : {}),
      useCase: "cover_letter",
      jobId: context.preparation.jobId,
    }
  }
  if (toolName === "resume.get_base") return { resumeId: context.baseResumeId }
  return undefined
}

export function createSelectedJobReadRouter(
  router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> },
  selectedContext: SelectedJobArtifactContextBundle | undefined,
): { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> } {
  return {
    execute: (context, request) => {
      const isSelectedRead = Boolean(selectedContext && isSelectedJobReadTool(request.toolName))
      const input = isSelectedRead ? bindSelectedJobReadInput(request.toolName, request.input, selectedContext!) : undefined
      if (isSelectedRead && input === undefined) {
        return Promise.resolve({
          ...request, status: "failed", output: { error: "selected_job_input_unavailable" }, errorCode: "selected_job_input_unavailable",
        })
      }
      return router.execute({
        ...context,
        ...(selectedContext ? { selectedJobPreparation: selectedContext.preparation } : {}),
      }, isSelectedRead ? { ...request, input } : request)
    },
  }
}

function redactSelectedJobReadInputs<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactSelectedJobReadInputs(item)) as T
  if (!value || typeof value !== "object") return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const row = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(row)) {
    result[key] = key === "input" && typeof row.toolName === "string" && isSelectedJobReadTool(row.toolName)
      ? { scope: "server-selected-job" }
      : redactSelectedJobReadInputs(child)
  }
  return result as T
}

/** Keep selected source selectors out of durable child items and event payloads. */
export function withSelectedJobInputRedaction(store: TurnExecutionStore, enabled = true): TurnExecutionStore {
  if (!enabled) return store
  const safe = <T>(value: T): T => redactSelectedJobReadInputs(value)
  return {
    ...store,
    createItem: input => store.createItem({ ...input, content: safe(input.content) }),
    updateItem: input => store.updateItem({ ...input, content: safe(input.content) }),
    appendEvent: input => store.appendEvent({ ...input, payload: safe(input.payload) }),
    ...(store.appendEvents ? { appendEvents: inputs => store.appendEvents!(inputs.map(input => ({ ...input, payload: safe(input.payload) }))) } : {}),
  }
}

export function redactSelectedEvidenceResult(value: StructuredRoleResult, context: SelectedJobArtifactContextBundle): StructuredRoleResult {
  if (value.role === "scout") {
    const selectedJob = context.transientSources.find(source => source.sourceRef === `job:${context.preparation.jobId}`)
    const job = selectedJob?.content && typeof selectedJob.content === "object" && !Array.isArray(selectedJob.content)
      ? selectedJob.content as Record<string, unknown> : {}
    const source = typeof job.source === "string" && job.source.trim() ? job.source : "other"
    const url = typeof job.url === "string" && job.url.trim() ? job.url : null
    return {
      ...value,
      candidates: value.candidates.map(candidate => ({ ...candidate, jobId: context.preparation.jobId, source, url })),
      summary: SELECTED_JOB_PRIVATE_PLACEHOLDER,
    }
  }
  return value.role === "analyst" ? { ...value, summary: SELECTED_JOB_PRIVATE_PLACEHOLDER } : value
}

/** Re-load the selected job and approved profile sources under the current Worker tenant fence. */
export async function loadSelectedJobArtifactContext(
  pool: Pick<pg.Pool, "query">,
  userId: string,
  jobId: string,
): Promise<SelectedJobArtifactContextBundle> {
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
  return {
    preparation: createSelectedJobPreparation(job.id, materials),
    baseResumeId: resume.id,
    transientSources: materials,
  }
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
