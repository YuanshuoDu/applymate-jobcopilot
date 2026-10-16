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
  inferMiniMaxRegionFromApiKey,
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
export { canonicalJson, CanonicalJsonError, hashContent } from "./canonical-json.js";
export { canonicalJsonFixtures, type CanonicalJsonFixture } from "./fixtures/canonical-json-fixtures.js";
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

interface ApplyTaskPayloadBase {
  readonly applicationTaskId: string;
  readonly jobId: string;
  readonly userId: string;
  readonly applyUrl: string;
  readonly personaId: string;
  readonly resumePath: string;
  readonly coverLetterPath?: string;
  readonly dryRun?: boolean;
}

export interface ApplyTaskSubmitIdentity {
  readonly applicationTaskId: string;
  readonly jobId: string;
  readonly userId: string;
  readonly sessionId: string;
  /** The immutable canonical fill Turn authorized for this submit. */
  readonly fillTurnId: string;
  /** The existing AgentApproval.id; do not mint a parallel approval ID. */
  readonly receiptId: string;
  readonly constraintHash: string;
}

export interface ApplyTaskSubmitPayload extends ApplyTaskPayloadBase, ApplyTaskSubmitIdentity {
  readonly operation: "submit";
}

interface ApplyTaskFillPayload extends ApplyTaskPayloadBase {
  readonly operation: "fill";
  readonly receiptId?: never;
  readonly constraintHash?: never;
}

/** Job payload pushed to the apply-tasks queue. Submit is an identity-bound variant. */
export type ApplyTaskPayload = ApplyTaskFillPayload | ApplyTaskSubmitPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Checks a decoded submit payload against the current task and approval identity. */
export function matchesApplyTaskSubmitPayload(
  value: unknown,
  expected: ApplyTaskSubmitIdentity,
): value is ApplyTaskSubmitPayload {
  if (!isRecord(value) || value.operation !== "submit" || typeof value.applyUrl !== "string" ||
    typeof value.personaId !== "string" || typeof value.resumePath !== "string" ||
    (value.coverLetterPath !== undefined && typeof value.coverLetterPath !== "string") ||
    (value.dryRun !== undefined && typeof value.dryRun !== "boolean")) return false;
  const identityKeys: (keyof ApplyTaskSubmitIdentity)[] = [
    "applicationTaskId", "jobId", "userId", "sessionId", "fillTurnId", "receiptId", "constraintHash",
  ];
  return identityKeys.every(key => isNonEmptyString(value[key]) && value[key] === expected[key]);
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
