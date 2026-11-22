import pg from "pg";
import { credentialContext, decryptSecret } from "./secret-crypto.js";

export type Provider = "minimax" | "openai" | "anthropic" | "deepseek" | "qwen" | "zhipu" | "kimi" | "custom";

export interface AiConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  apiBase?: string;
  thinking?: "adaptive" | "disabled";
  credentialSource?: "platform" | "user";
}

export const APPLYMATE_BACKING: AiConfig = {
  provider: "minimax",
  model: "MiniMax-M3",
  thinking: "adaptive",
};

export type WorkerAgentAiRoute = Readonly<{
  source: "agent" | "legacy";
  config: AiConfig;
}>;

type AiQueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

let sharedPool: pg.Pool | null = null;

export function getWorkerAiPool(): pg.Pool {
  if (!sharedPool) sharedPool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://localhost:5432/applymate", max: 2 });
  return sharedPool;
}

/** Load the legacy Worker route, preserving AutoApply and platform fallback selection. */
export async function loadWorkerAiConfig(userId: string): Promise<AiConfig> {
  const client = await getWorkerAiPool().connect();
  try { return await resolveLegacyWorkerAiConfig(client, await loadUserPreferences(client, userId)); }
  finally { client.release(); }
}

/** Load the Agent override once and identify whether the legacy route was used. */
export async function loadWorkerAgentAiRoute(userId: string): Promise<WorkerAgentAiRoute> {
  const client = await getWorkerAiPool().connect();
  try {
    const rawPreferences = await readUserPreferences(client, userId);
    const aiSettings = asRecord(asRecord(rawPreferences).aiSettings);
    const features = asRecord(aiSettings.features);
    const override = features.agent;
    if (override === undefined || override === null) {
      const preferences = await decryptWorkerAiSettings(rawPreferences, userId);
      return { source: "legacy", config: await resolveLegacyWorkerAiConfig(client, preferences) };
    }

    const configured = strictAgentConfig(override);
    const userKey = await decryptAgentUserKey(aiSettings, configured, userId);
    const platformKey = userKey ? undefined : getServerKey(configured.provider);
    const apiKey = userKey || platformKey;
    if (!apiKey) throw new Error("AI Agent model route has no authorized credential");
    return { source: "agent", config: { ...configured, apiKey, credentialSource: userKey ? "user" : "platform" } };
  } finally {
    client.release();
  }
}

async function loadUserPreferences(client: AiQueryClient, userId: string): Promise<unknown> {
  return decryptWorkerAiSettings(await readUserPreferences(client, userId), userId);
}

async function readUserPreferences(client: AiQueryClient, userId: string): Promise<unknown> {
  const result = await client.query(`SELECT preferences FROM "User" WHERE id = $1`, [userId]);
  const row = result.rows[0] as { preferences?: unknown } | undefined;
  return row?.preferences;
}

async function decryptAgentUserKey(aiSettings: Record<string, unknown>, config: AiConfig, userId: string): Promise<string | undefined> {
  const featureKey = stringValue(config.apiKey);
  const providerKey = featureKey ? undefined : stringValue(asRecord(aiSettings.keys)[config.provider]);
  const selectedKey = featureKey ?? providerKey;
  if (!selectedKey) return undefined;
  const purpose = featureKey ? `ai:${userId}:feature:agent` : `ai:${userId}:provider:${config.provider}`;
  const decrypted = stringValue(await decryptSecret(selectedKey, credentialContext(purpose)));
  if (!decrypted) throw new Error("AI Agent model credential is invalid");
  return decrypted;
}

async function resolveLegacyWorkerAiConfig(client: AiQueryClient, preferences: unknown): Promise<AiConfig> {
  const aiSettings = asRecord(asRecord(preferences).aiSettings);
  const features = asRecord(aiSettings.features);
  const configured = asAiConfig(features.autoApply);
  if (configured) return resolveWorkerAiConfig(preferences);

  const keys = stringRecord(aiSettings.keys);
  const platform = await loadPlatformRoute(client, keys);
  return platform ?? withUserKey(APPLYMATE_BACKING, keys);
}

function withUserKey(config: AiConfig, keys: Record<string, string> | undefined): AiConfig {
  const userKey = config.apiKey?.trim() || keys?.[config.provider]?.trim();
  return { ...config, apiKey: userKey || undefined, credentialSource: userKey ? "user" : "platform" };
}

async function loadPlatformRoute(client: AiQueryClient, keys: Record<string, string> | undefined): Promise<AiConfig | null> {
  try {
    const routeResult = await client.query(
      `SELECT "defaultProvider", "defaultModel", "fallbackProvider", "fallbackModel" FROM "ai_route_configs" WHERE "featureKey" = $1`,
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
         FROM "ai_provider_configs" AS provider JOIN "ai_model_configs" AS model ON model."providerId" = provider.id
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
    // AI configuration tables are additive; older Worker deployments use the environment-backed default.
  }
  return null;
}

/** Resolve persisted Preferences JSON without opening a database connection. */
export function resolveWorkerAiConfig(preferences: unknown): AiConfig {
  const aiSettings = asRecord(asRecord(preferences).aiSettings);
  const configured = asAiConfig(asRecord(aiSettings.features).autoApply);
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

function strictAgentConfig(value: unknown): AiConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid AI Agent model configuration");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["provider", "model", "apiKey", "apiBase", "thinking"].includes(key))) {
    throw new Error("Invalid AI Agent model configuration");
  }
  const provider = raw.provider;
  const model = stringValue(raw.model);
  if (!isProvider(provider) || !model || model.length > 200) throw new Error("Invalid AI Agent model configuration");
  if (raw.apiKey !== undefined && raw.apiKey !== null && (typeof raw.apiKey !== "string" || raw.apiKey.length > 4_096)) throw new Error("Invalid AI Agent model configuration");
  if (raw.apiBase !== undefined && raw.apiBase !== null && (typeof raw.apiBase !== "string" || raw.apiBase.length > 2_048)) throw new Error("Invalid AI Agent model configuration");
  if (raw.thinking !== undefined && raw.thinking !== "adaptive" && raw.thinking !== "disabled") throw new Error("Invalid AI Agent model configuration");
  const apiBase = stringValue(raw.apiBase);
  if ((provider === "custom" && !apiBase) || (provider !== "custom" && apiBase)) throw new Error("Invalid AI Agent model configuration");
  return {
    provider,
    model,
    ...(stringValue(raw.apiKey) ? { apiKey: stringValue(raw.apiKey) } : {}),
    ...(apiBase ? { apiBase } : {}),
    ...(raw.thinking === "adaptive" || raw.thinking === "disabled" ? { thinking: raw.thinking } : {}),
  };
}

export function closeSharedPool(): void {
  if (sharedPool) sharedPool.end().catch(() => {});
  sharedPool = null;
}

export function getServerKey(provider: Provider): string | undefined {
  const envMap: Record<Provider, string | undefined> = {
    minimax: process.env.MINIMAX_API_KEY, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY, qwen: process.env.QWEN_API_KEY, zhipu: process.env.ZHIPU_API_KEY,
    kimi: process.env.KIMI_API_KEY, custom: undefined,
  };
  return envMap[provider];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asAiConfig(value: unknown): AiConfig | null {
  const raw = asRecord(value);
  const provider = raw.provider;
  const model = stringValue(raw.model);
  if (!isProvider(provider) || !model) return null;
  const apiBase = provider === "custom" ? stringValue(raw.apiBase) : undefined;
  if (provider === "custom" && !apiBase) return null;
  const thinking = raw.thinking === "adaptive" || raw.thinking === "disabled" ? raw.thinking : undefined;
  return { provider, model, ...(stringValue(raw.apiKey) ? { apiKey: stringValue(raw.apiKey) } : {}), ...(apiBase ? { apiBase } : {}), ...(thinking ? { thinking } : {}) };
}

function isProvider(value: unknown): value is Provider {
  return value === "minimax" || value === "openai" || value === "anthropic" || value === "deepseek" || value === "qwen" || value === "zhipu" || value === "kimi" || value === "custom";
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
    if (typeof value === "string") decryptedKeys[provider] = await decryptSecret(value, credentialContext(`ai:${userId}:provider:${provider}`));
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
  return { ...root, aiSettings: { ...aiSettings, keys: decryptedKeys, features: decryptedFeatures } };
}
