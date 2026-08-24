import pg from "pg";
import { isSafeAiEndpoint } from "./safe-ai-endpoint.js";
import { credentialContext, decryptSecret } from "./secret-crypto.js";
import { pinnedFetch } from "./pinned-outbound.js";
import { recordSharedAiUsage, sharedAiUsageErrorCode } from "./ai-usage.js";

// ── Types ──

export type Provider = "minimax" | "openai" | "anthropic" | "deepseek" | "qwen" | "zhipu" | "kimi" | "custom";

export interface AiConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  apiBase?: string;
  thinking?: "adaptive" | "disabled";
  credentialSource?: "platform" | "user";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  provider: Provider;
  model: string;
}

// ── Defaults ──

export const APPLYMATE_BACKING: AiConfig = {
  provider: "minimax",
  model: "MiniMax-M3",
  thinking: "adaptive",
};

const DEFAULT_API_BASES: Record<Provider, string> = {
  minimax: "https://api.minimax.io/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://api.z.ai/api/paas/v4",
  kimi: "https://api.moonshot.ai/v1",
  custom: "",
};

// ── Load AI config from Postgres (raw SQL, no Prisma) ──

let sharedPool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!sharedPool) {
    const connectionString =
      process.env.DATABASE_URL ?? "postgresql://localhost:5432/applymate";
    sharedPool = new pg.Pool({ connectionString, max: 2 });
  }
  return sharedPool;
}

/**
 * Load the user's AI config for the 'autoApply' feature.
 * Reads User.preferences JSONB column via raw SQL.
 * Falls back to APPLYMATE_BACKING if no config is set.
 */
export async function loadWorkerAiConfig(userId: string): Promise<AiConfig> {
  const client = await getPool().connect();
  try {
    const res = await client.query(
      `SELECT preferences FROM "User" WHERE id = $1`,
      [userId]
    );
    const preferences = await decryptWorkerAiSettings(res.rows[0]?.preferences, userId)
    const root = asRecord(preferences)
    const aiSettings = asRecord(root.aiSettings)
    const features = asRecord(aiSettings.features)
    const configured = asAiConfig(features.autoApply)
    if (configured) return resolveWorkerAiConfig(preferences)

    const keys = stringRecord(aiSettings.keys)
    const platform = await loadPlatformRoute(client, keys)
    return platform ?? withUserKey(APPLYMATE_BACKING, keys)
  } finally {
    client.release();
  }
}

function withUserKey(config: AiConfig, keys: Record<string, string> | undefined): AiConfig {
  const userKey = config.apiKey?.trim() || keys?.[config.provider]?.trim();
  return {
    ...config,
    apiKey: userKey || undefined,
    credentialSource: userKey ? "user" : "platform",
  };
}

async function loadPlatformRoute(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  keys: Record<string, string> | undefined,
): Promise<AiConfig | null> {
  try {
    const routeResult = await client.query(
      `SELECT "defaultProvider", "defaultModel", "fallbackProvider", "fallbackModel"
       FROM "ai_route_configs" WHERE "featureKey" = $1`,
      ["autoApply"],
    );
    const route = routeResult.rows[0] as Record<string, unknown> | undefined;
    if (!route) return null;

    const candidates = [
      { provider: route.defaultProvider, model: route.defaultModel },
      { provider: route.fallbackProvider, model: route.fallbackModel },
    ];
    const hasFallback = typeof route.fallbackProvider === "string" && typeof route.fallbackModel === "string";
    for (const [index, candidate] of candidates.entries()) {
      if (!isProvider(candidate.provider) || typeof candidate.model !== "string" || !candidate.model.trim()) continue;
      const providerResult = await client.query(
        `SELECT provider.key, provider."apiBase", provider."secretRef", provider.enabled, model.active
         FROM "ai_provider_configs" AS provider
         JOIN "ai_model_configs" AS model ON model."providerId" = provider.id
         WHERE provider.key = $1 AND model.model = $2`,
        [candidate.provider, candidate.model],
      );
      const row = providerResult.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.enabled !== true || row.active !== true) continue;
      const platformKey = (typeof row.secretRef === "string" ? process.env[row.secretRef] : undefined) || getServerKey(candidate.provider);
      const userKey = keys?.[candidate.provider]?.trim();
      const apiKey = platformKey || userKey;
      if (!apiKey && hasFallback && index === 0) continue;
      return { provider: candidate.provider, model: candidate.model, apiBase: String(row.apiBase ?? ""), apiKey, credentialSource: platformKey ? "platform" : "user" };
    }
  } catch {
    // AI configuration tables are additive; older worker deployments fall back
    // to the environment-backed configuration until migrations complete.
  }
  return null;
}

/** Resolve persisted Preferences JSON without opening a database connection. */
export function resolveWorkerAiConfig(preferences: unknown): AiConfig {
  const root = asRecord(preferences);
  const aiSettings = asRecord(root.aiSettings);
  const features = asRecord(aiSettings.features);
  const configured = asAiConfig(features.autoApply);
  if (!configured) return { ...APPLYMATE_BACKING };

  const keys = asRecord(aiSettings.keys);
  const apiKey = stringValue(configured.apiKey) ?? stringValue(keys[configured.provider]);
  return {
    provider: configured.provider,
    model: configured.model,
    ...(apiKey ? { apiKey } : {}),
    ...(configured.apiBase ? { apiBase: configured.apiBase } : {}),
    ...(configured.thinking ? { thinking: configured.thinking } : {}),
    credentialSource: apiKey ? "user" : "platform",
  };
}

/** Close the shared pool (for tests/cleanup) */
export function closeSharedPool(): void {
  if (sharedPool) {
    sharedPool.end().catch(() => {});
    sharedPool = null;
  }
}

// ── LLM Call ──

/**
 * Call an LLM with chat messages and return the text response.
 * Supports MiniMax (OpenAI-compatible), OpenAI, Anthropic, DeepSeek.
 */
export async function callLlm(
  messages: ChatMessage[],
  config: AiConfig,
  usageContext?: { userId?: string; featureKey?: string },
): Promise<ChatResult> {
  const provider = config.provider;
  const startedAt = Date.now();
  try {
    const result = provider === "anthropic"
      ? await callAnthropic(messages, config)
      : await callOpenAICompat(messages, config);
    if (process.env.NODE_ENV !== "test") await recordSharedAiUsage(getPool(), { ...usageContext, provider: result.provider, model: result.model, credentialSource: config.credentialSource ?? (config.apiKey ? "user" : "platform"), inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - startedAt, status: "success" });
    return result;
  } catch (error) {
    if (process.env.NODE_ENV !== "test") await recordSharedAiUsage(getPool(), { ...usageContext, provider, model: config.model, credentialSource: config.credentialSource ?? (config.apiKey ? "user" : "platform"), latencyMs: Date.now() - startedAt, status: "error", errorCode: sharedAiUsageErrorCode(error) });
    throw error;
  }
}

// ── Provider implementations ──

async function callOpenAICompat(
  messages: ChatMessage[],
  config: AiConfig
): Promise<ChatResult> {
  const base = config.apiBase || DEFAULT_API_BASES[config.provider];
  if (config.provider === "custom" && !isSafeAiEndpoint(base)) {
    throw new Error("Custom AI endpoint is not an allowed public HTTPS destination");
  }
  const key = config.apiKey || getServerKey(config.provider);
  if (!key) throw new Error(`No API key for provider "${config.provider}"`);

  // Keep MiniMax reasoning in message.content for the harness's multi-turn
  // history. The MiniMax docs require that chain to be sent back on later
  // tool turns, so this worker intentionally does not enable reasoning_split.
  const providerOptions = config.provider === "minimax"
    ? {
        max_completion_tokens: 4096,
        ...(config.model === "MiniMax-M3"
          ? { thinking: { type: config.thinking ?? "adaptive" } }
          : {}),
      }
    : { max_tokens: 4096 };

  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...providerOptions,
      temperature: 0.3,
    }),
  };
  const res = await pinnedFetch(`${base}/chat/completions`, {
    ...request,
    allowLocalDevelopment: config.provider === "custom" && process.env.NODE_ENV !== "production",
    redirect: "error",
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `LLM API error ${res.status} from ${config.provider}: ${errBody.substring(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    text,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    provider: config.provider,
    model: config.model,
  };
}

async function callAnthropic(
  messages: ChatMessage[],
  config: AiConfig
): Promise<ChatResult> {
  const key = config.apiKey || getServerKey("anthropic");
  if (!key) throw new Error("No API key for provider \"anthropic\"");

  // Split system message from chat messages
  let systemContent = "";
  const chatMsgs: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemContent += (systemContent ? "\n\n" : "") + m.content;
    } else {
      chatMsgs.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    messages: chatMsgs,
  };
  if (systemContent) body.system = systemContent;

  const res = await pinnedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Anthropic API error ${res.status}: ${errBody.substring(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  return {
    text,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    provider: "anthropic",
    model: config.model,
  };
}

// ── Helpers ──

function getServerKey(provider: Provider): string | undefined {
  const envMap: Record<string, string | undefined> = {
    minimax: process.env.MINIMAX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    qwen: process.env.QWEN_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY,
    kimi: process.env.KIMI_API_KEY,
    custom: undefined,
  };
  return envMap[provider];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asAiConfig(value: unknown): AiConfig | null {
  const raw = asRecord(value);
  const provider = raw.provider;
  const model = stringValue(raw.model);
  if (!isProvider(provider) || !model) return null;
  const apiBase = provider === "custom" ? stringValue(raw.apiBase) : undefined;
  if (provider === "custom" && !apiBase) return null;
  const thinking = raw.thinking === "adaptive" || raw.thinking === "disabled"
    ? raw.thinking
    : undefined;
  return {
    provider,
    model,
    ...(stringValue(raw.apiKey) ? { apiKey: stringValue(raw.apiKey) } : {}),
    ...(apiBase ? { apiBase } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function isProvider(value: unknown): value is Provider {
  return value === "minimax" || value === "openai" || value === "anthropic" ||
    value === "deepseek" || value === "qwen" || value === "zhipu" ||
    value === "kimi" || value === "custom";
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = stringValue(item);
    if (normalized) record[key] = normalized;
  }
  return record;
}

async function decryptWorkerAiSettings(preferences: unknown, userId: string): Promise<unknown> {
  const root = asRecord(preferences);
  const aiSettings = asRecord(root.aiSettings);
  const keys = asRecord(aiSettings.keys);
  const features = asRecord(aiSettings.features);
  const decryptedKeys: Record<string, unknown> = { ...keys };
  for (const [provider, value] of Object.entries(keys)) {
    if (typeof value === "string") {
      decryptedKeys[provider] = await decryptSecret(value, credentialContext(`ai:${userId}:provider:${provider}`));
    }
  }
  const decryptedFeatures: Record<string, unknown> = { ...features };
  for (const [feature, value] of Object.entries(features)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const config = value as Record<string, unknown>;
    if (typeof config.apiKey !== "string") continue;
    decryptedFeatures[feature] = {
      ...config,
      apiKey: await decryptSecret(config.apiKey, credentialContext(`ai:${userId}:feature:${feature}`)),
    };
  }
  return {
    ...root,
    aiSettings: {
      ...aiSettings,
      keys: decryptedKeys,
      features: decryptedFeatures,
    },
  };
}

/** Convenience: call LLM and return only the text string */
export async function callLlmText(
  messages: ChatMessage[],
  config: AiConfig,
  usageContext?: { userId?: string; featureKey?: string },
): Promise<string> {
  const result = await callLlm(messages, config, usageContext);
  return result.text;
}
