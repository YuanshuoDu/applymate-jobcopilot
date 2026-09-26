import type { Job } from '@prisma/client'
import type { AiConfig } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'
import type { OrchestratorAgent } from './orchestrator'
import type {
  AgentConfigFull,
  AgentQuestionOption,
  ApplicationPackage,
  CustomAgentRunResult,
  GateOutput,
  PipelineCanonicalEvent,
  PipelineCheckpointState,
  PipelineStage,
  RunReport,
  RoleConfigMap,
  ScoredJob,
} from './types'
import type { AgentRoleType } from './role-config'

/** Full run context threaded through every pipeline stage. */
export interface PipelineCtx {
  userId: string
  /** Durable session that owns approvals and resumable application checkpoints. */
  sessionId?: string
  /** Exact V2 Turn projected for this pipeline run, including legacy dual-write runs. */
  turnId?: string
  /** Whether Orchestrator questions project a canonical wait item or legacy-only row. */
  questionProjectionMode?: 'legacy' | 'canonical'
  /** Exact answered question identity dispatched by the durable answer outbox. */
  resumeQuestionId?: string
  agentCfg: AgentConfigFull
  roleConfigs: RoleConfigMap // Per-role model configs.
  resumeText: string // Plain-text resume, truncated to 2500 chars.
  resumeContent: ResumeContent // Structured resume for cover-letter generation.
  defaultResume: { id: string; name: string; templateId: string | null; templateOptions: unknown; directionId: string | null; basicsDetached: boolean }
  aiConfig: AiConfig // Fallback global config.
  autonomous: boolean // May work unattended, but never bypasses a required user decision.
  emit: (event: string, data: unknown) => void
  /** Last durable stage snapshot, loaded after a worker/service restart. */
  resumeState?: PipelineCheckpointState
  /** Program-owned persistence hook; models never receive or control it. */
  checkpoint?: (state: PipelineCheckpointState) => Promise<void>
  /** Canonical Turn adapter sink. Legacy callers leave this unset. */
  onCanonicalEvent?: (event: PipelineCanonicalEvent) => Promise<void> | void
  /** Abort-aware boundary owned by the canonical Turn executor. */
  signal?: AbortSignal
  /** Current durable execution generation; absent only for direct legacy callers. */
  executionAttempt?: { id: string; attemptCount: number }
  /** Read-only check used after awaited stages to stop a reclaimed runner. */
  assertExecutionCurrent?: () => Promise<boolean>
  /** Durable human-decision boundary supplied by the Orchestrator. */
  askUser?: (stage: string, question: string, options: AgentQuestionOption[]) => Promise<string>
}

/** Explicit dependencies passed by the coordinator to each stage group. */
export interface PipelineStageRuntimeContext {
  ctx: PipelineCtx
  pipelineCtx: PipelineCtx
  controlledCtx: PipelineCtx
  orchestrator: OrchestratorAgent
  getState: () => PipelineCheckpointState
  needsStage: (stage: PipelineStage) => boolean
  emit: (event: string, data: unknown) => void
  emitRole: (ctx: PipelineCtx, role: string, event: 'start' | 'done', extra?: Record<string, unknown>) => void
  assertAlive: () => Promise<void>
  flushCanonical: () => Promise<void>
  persist: (nextStage: PipelineCheckpointState['nextStage'], patch?: Partial<PipelineCheckpointState>) => Promise<void>
  collectCustomResults: (jobs: Job[], afterStage: string) => Promise<void>
  recordRoleRun: (role: AgentRoleType, result: { count: number; durationMs: number; summary: string }) => Promise<void>
  getCustomAgentResults: () => CustomAgentRunResult[]
  throwInterrupted: () => never
  startedAt: number
}

export interface PipelineScoutAnalyzeResult {
  terminalReport?: RunReport
  scoutedJobs: Job[]
  scoredJobs: ScoredJob[]
  analysisFailed: number
}

export interface PipelinePrepareGateResult {
  preparedPackages: ApplicationPackage[]
  gateOutput: GateOutput
}

export type PipelineExecuteAuditInput = PipelineScoutAnalyzeResult & PipelinePrepareGateResult

export interface PipelineExecuteAuditResult {
  report: RunReport
}
