// ── LLM utilities ─────────────────────────────────────────────────────────────
// IMPORTANT: Do NOT remove these exports.
// apps/worker/src/db/load-task-context.ts imports callLlm + loadWorkerAiConfig
// from this package. Worker cannot import apps/web/src/lib/model-router.ts
// (Prisma dependency) — this shared package is the isolation layer.
export type { AiConfig, ChatMessage, ChatResult, Provider } from "./llm.js";
export { callLlm, callLlmText, loadWorkerAiConfig, closeSharedPool } from "./llm.js";

/** Job payload pushed to the apply-tasks queue */
export interface ApplyTaskPayload {
  jobId: string;
  userId: string;
  applyUrl: string;
  personaId: string;
  resumePath: string;
  coverLetterPath?: string;
  dryRun?: boolean;
}

/** Outcome written to apply_results after each task */
export interface ApplyResult {
  id?: number;
  userId: string;
  jobId: string;
  mode: 'unattended' | 'assisted';
  atsType?: string | null;
  flowUsed?: string | null;
  status: 'submitted' | 'manual' | 'failed' | 'dry-run';
  error?: string | null;
  durationMs?: number | null;
  createdAt?: string;
}

/** Rate-limit check response */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}
