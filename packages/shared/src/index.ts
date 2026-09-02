// ── LLM utilities ─────────────────────────────────────────────────────────────
// IMPORTANT: Do NOT remove these exports.
// apps/worker/src/db/load-task-context.ts imports callLlm + loadWorkerAiConfig
// from this package. Worker cannot import apps/web/src/lib/model-router.ts
// (Prisma dependency) — this shared package is the isolation layer.
export type { AiConfig, ChatMessage, ChatResult, Provider } from "./llm.js";
export { callLlm, callLlmText, loadWorkerAiConfig, resolveWorkerAiConfig, closeSharedPool } from "./llm.js";
export { estimateSharedAiCost, recordSharedAiUsage, sharedAiUsageErrorCode } from "./ai-usage.js";
export {
  MINIMAX_CN_ANTHROPIC_BASE_URL,
  MINIMAX_CN_OPENAI_BASE_URL,
  MINIMAX_DEFAULT_ANTHROPIC_BASE_URL,
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL,
  MINIMAX_INTERNATIONAL_OPENAI_BASE_URL,
  miniMaxAnthropicBaseUrl,
  miniMaxOpenAiBaseUrl,
  parseMiniMaxRegion,
  resolveMiniMaxBaseUrl,
  type MiniMaxBaseUrlOptions,
  type MiniMaxRegion,
} from "./minimax.js";
export {
  ATS_POLICIES,
  getDefaultAtsPolicy,
  getHardRpsLimit,
  isAtsSourceKey,
  type DefaultAtsPolicy,
  type AtsSourceKey,
} from "./ats-policy.js";
export { detectAtsSource } from "./ats-url.js";
export { isSafeAiEndpoint } from "./safe-ai-endpoint.js";
export { credentialContext, decryptSecret, encryptSecret, isEncryptedSecret, maskStoredSecret } from "./secret-crypto.js";
export { pinnedFetch, validatePinnedUrl, type PinnedFetchOptions } from "./pinned-outbound.js";
export { redactAgentEvent, redactSensitiveText, redactSensitiveValue } from "./agent-redaction.js";
export { hashAgentReceiptValue } from "./agent-receipt.js";
export { normalizeExternalApiErrorCode, sharedExternalApiErrorCode, type ExternalApiErrorCode, type SharedExternalApiUsage, recordSharedExternalApiUsage } from "./external-api-usage.js";
export { getAzureManagementToken, type AzureManagementTokenCredential } from "./azure-management.js";
export {
  AGENT_HARNESS_FEATURES,
  evaluateManagedFeature,
  evaluateAgentHarnessFeature,
  getAgentHarnessFeatureHealth,
  isAgentHarnessFeatureKey,
  isManagedFeatureKey,
  isPlatformFeatureKey,
  MANAGED_FEATURES,
  PLATFORM_FEATURES,
  platformEnvironment,
  type AgentHarnessFeatureFallback,
  type AgentHarnessFeatureHealth,
  type AgentHarnessFeatureKey,
  type FeatureFlagEvaluationInput,
  type ManagedFeatureKey,
  type ManagedFeatureOverride,
  type PlatformEnvironment,
  type PlatformFeatureKey,
} from "./feature-flags.js";

/** Job payload pushed to the apply-tasks queue */
export interface ApplyTaskPayload {
  /** Durable control-plane record. Worker refuses a missing or revoked task. */
  applicationTaskId: string;
  /** First pass fills only; submit requires a second, explicit authorization. */
  operation: "fill" | "submit";
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
  status: 'submitted' | 'manual' | 'failed' | 'dry-run' | 'submission_blocked';
  error?: string | null;
  durationMs?: number | null;
  createdAt?: string;
}

/** Rate-limit check response */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}
