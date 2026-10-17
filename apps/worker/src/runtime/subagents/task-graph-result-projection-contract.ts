export type TaskGraphProjectionSource = "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other"
export type TaskGraphProjectionEvidenceKind = "job" | "persona" | "resume" | "source"
export const TASK_GRAPH_RESULT_PROJECTION_SCHEMA = "agent-harness.v2.task-graph.result-projection" as const
export type TaskGraphScoutProjectionItem = Readonly<{
  jobId: string
  source: TaskGraphProjectionSource
  evidenceKinds: readonly TaskGraphProjectionEvidenceKind[]
}>
export type TaskGraphAnalystProjectionItem = Readonly<{
  jobId: string
  score: number
  evidenceKinds: readonly TaskGraphProjectionEvidenceKind[]
}>
export type TaskGraphArtifactProjectionReference = Readonly<{
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
}>
export type TaskGraphResultProjection =
  | Readonly<{ schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA; trust: "untrusted"; availability: "unavailable" }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "scout"
    status: "completed" | "partial"
    candidateCount: number
    evidenceCount: number
    candidates: readonly TaskGraphScoutProjectionItem[]
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "analyst"
    status: "completed" | "partial"
    findingCount: number
    evidenceCount: number
    findings: readonly TaskGraphAnalystProjectionItem[]
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "writer"
    status: "completed"
    artifactRef: TaskGraphArtifactProjectionReference
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "reviewer"
    status: "completed"
    artifactRef: TaskGraphArtifactProjectionReference
    reviewStatus: "passed" | "needs_revision" | "rejected" | "stale"
    reviewHash: string
  }>
