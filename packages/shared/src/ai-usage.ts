import { randomUUID } from "node:crypto";

export type SharedAiUsageInput = {
  userId?: string;
  featureKey?: string;
  provider: string;
  model: string;
  credentialSource: "platform" | "user";
  runtime?: "web" | "worker" | "admin" | "unknown";
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  status: "success" | "error";
  errorCode?: string;
};

type Queryable = { query: (text: string, values?: unknown[]) => Promise<unknown> };

const prices: Record<string, { input: number; output: number }> = {
  "minimax:MiniMax-M3": { input: 0.6, output: 2.4 },
  "minimax:MiniMax-M2.7-highspeed": { input: 0.6, output: 2.4 },
  "openai:gpt-5.5": { input: 5, output: 30 },
  "openai:gpt-5.6-sol": { input: 5, output: 30 },
  "openai:gpt-5.6-terra": { input: 2.5, output: 15 },
  "openai:gpt-5.6-luna": { input: 1, output: 6 },
  "deepseek:deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek:deepseek-v4-flash": { input: 0.14, output: 0.28 },
};

const STABLE_ERROR_CODES = new Set(["configuration_error", "network_error", "provider_error", "timeout"]);

export function sharedAiUsageErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.toLowerCase();
  const status = message.match(/(?:api error|http(?: status)?|status)\s*[:=]?\s*([1-5]\d{2})/i)?.[1];
  if (status) return `http_${status}`;
  if (name === "aborterror" || /timeout|timed out|aborted/.test(normalized)) return "timeout";
  if (/fetch failed|econnreset|econnrefused|enotfound|network/.test(normalized)) return "network_error";
  if (/no api key|configuration|not an allowed|api base url/.test(normalized)) return "configuration_error";
  return "provider_error";
}

function stableErrorCode(value: string | undefined): string | null {
  if (!value) return null;
  if (STABLE_ERROR_CODES.has(value) || /^http_[1-5]\d{2}$/.test(value)) return value;
  return sharedAiUsageErrorCode(value);
}

export function estimateSharedAiCost(input: SharedAiUsageInput): number {
  const price = prices[`${input.provider}:${input.model}`];
  if (!price) return 0;
  return Number((((input.inputTokens ?? 0) * price.input + (input.outputTokens ?? 0) * price.output) / 1_000_000).toFixed(8));
}

export async function recordSharedAiUsage(db: Queryable, input: SharedAiUsageInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ai_usage_events
        (id, user_id, feature_key, provider, model, input_tokens, output_tokens,
         estimated_cost_usd, latency_ms, status, error_code, credential_source, runtime, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [randomUUID(), input.userId ?? null, input.featureKey ?? "autoApply", input.provider, input.model,
       Math.max(0, Math.trunc(input.inputTokens ?? 0)), Math.max(0, Math.trunc(input.outputTokens ?? 0)),
       estimateSharedAiCost(input), Math.max(0, Math.trunc(input.latencyMs)), input.status,
       stableErrorCode(input.errorCode), input.credentialSource, input.runtime ?? "worker"],
    );
  } catch {
    // Observability is fail-open and must never block an application task.
  }
}
