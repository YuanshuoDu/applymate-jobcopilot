/**
 * Agent Pipeline — shared types
 * Every stage consumes and produces these typed structures.
 */
import type { Job }          from '@prisma/client'
import type { AiConfig }     from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'
import type { AgentRoleType } from '@/lib/agent/role-config'

export type { AgentRoleType }

// ── Role config map (passed through pipeline) ─────────────────────────────────

export type RoleConfigMap = Record<AgentRoleType, {
  provider:     string
  model:        string
  apiKey?:      string
  enabled:      boolean
  systemPrompt: string | null
}>

// ── Extended AgentConfig (DB record + new fields) ─────────────────────────────

export interface AgentConfigFull {
  id:                string
  userId:            string
  isRunning:         boolean
  dailyLimit:        number
  minMatchScore:     number
  autoApply:         boolean
  requireApproval:   boolean
  targetLocations:   string[]
  targetRoles:       string[]
  excludeCompanies:  string[]
  priorityCompanies: string[]
  autoCoverLetter:   boolean
  coverTone:         string
  useTailoredCV:     boolean
  model:             string
  throttleMs?:       number   // delay between per-job AI calls (ms), default 300
}

// ── Pipeline context (threaded through every stage) ───────────────────────────

export interface PipelineCtx {
  userId:        string
  agentCfg:      AgentConfigFull
  roleConfigs:   RoleConfigMap  // per-role model configs
  resumeText:    string         // plain-text resume, truncated to 2500 chars
  resumeContent: ResumeContent  // structured resume for cover-letter generation
  defaultResume: { id: string; name: string; templateId: string | null; templateOptions: unknown; directionId: string | null; basicsDetached: boolean }
  aiConfig:      AiConfig       // fallback global config
  autonomous:    boolean        // true = never pause, make all decisions automatically
  emit:          (event: string, data: unknown) => void
}

// ── Generic stage result ──────────────────────────────────────────────────────

export interface StageResult<T> {
  stage:   string
  ok:      boolean
  data?:   T
  error?:  string
  metrics: { durationMs: number; count: number }
}

export type AcceptResult = { ok: true } | { ok: false; reason: string }

// ── Stage 1: Scout ────────────────────────────────────────────────────────────

export interface ScoutOutput {
  jobs:       Job[]
  discovered: number   // how many new jobs were found by autonomous discovery
}

// ── Stage 2: Analyze ──────────────────────────────────────────────────────────

export interface ScoredJob {
  job:             Job
  score:           number
  matchedKeywords: string[]
  missingKeywords: string[]
  recommendation:  string
}

export interface AnalyzeOutput {
  scoredJobs: ScoredJob[]
  failed:     number
}

// ── Stage 3: Prepare ──────────────────────────────────────────────────────────

export interface ApplicationPackage extends ScoredJob {
  coverLetter?:      string
  tailoredKeywords?: string[]
  tailoredResumeId?: string
  tailoredResumeName?: string
}

export interface PrepareOutput {
  packages: ApplicationPackage[]
}

// ── Stage 4: Gate ─────────────────────────────────────────────────────────────

export interface GateOutput {
  approved: ApplicationPackage[]  // auto-apply or above threshold with no review req
  pending:  ApplicationPackage[]  // needs human review
  skipped:  ApplicationPackage[]  // below minMatchScore
}

// ── Stage 5: Execute ──────────────────────────────────────────────────────────

export interface ExecuteOutput {
  applied: string[]  // job IDs successfully applied
  failed:  string[]  // job IDs that failed to update
}

// ── Stage 6: Audit ────────────────────────────────────────────────────────────

export interface RunReport {
  processed:  number
  applied:    number
  pending:    number
  skipped:    number
  failed:     number
  durationMs: number
}

export interface AuditOutput {
  report:   RunReport
  warnings: string[]
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function emptyReport(durationMs = 0): RunReport {
  return { processed: 0, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs }
}

export function stageOk<T>(stage: string, data: T, count: number, durationMs: number): StageResult<T> {
  return { stage, ok: true, data, metrics: { durationMs, count } }
}

export function stageFail<T>(stage: string, error: string): StageResult<T> {
  return { stage, ok: false, error, metrics: { durationMs: 0, count: 0 } }
}

/** Convert a plain-text resume for AI prompts */
export function resumeToText(r: ResumeContent): string {
  const lines: string[] = []
  if (r.contact?.name) lines.push(`Name: ${r.contact.name}`)
  if (r.summary)        lines.push(`\nSUMMARY:\n${r.summary}`)
  if (r.skills?.length) lines.push(`\nSKILLS: ${r.skills.join(', ')}`)
  if (r.experience?.length) {
    lines.push('\nEXPERIENCE:')
    for (const e of r.experience) {
      lines.push(`${e.role} at ${e.company} (${e.period})`)
      for (const b of (e.bullets ?? [])) lines.push(`  • ${b}`)
    }
  }
  if (r.education?.length) {
    lines.push('\nEDUCATION:')
    for (const e of r.education) lines.push(`${e.degree} — ${e.institution} (${e.year})`)
  }
  return lines.join('\n')
}

// ── Enrichment pipeline ───────────────────────────────────────────────────────

export interface EnrichedJob {
  description: string
  applyUrl?: string
  salary?: string | null
  employmentType?: string | null
  datePosted?: string | null
  /** Which enrichment tier produced this result */
  method: "t0-ats" | "jsonld" | "css" | "llm"
}
