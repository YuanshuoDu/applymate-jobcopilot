import pg from "pg";

// ── Types ──

export type Provider = "minimax" | "openai" | "anthropic" | "deepseek" | "qwen" | "zhipu" | "kimi" | "custom";

export interface AiConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  apiBase?: string;
  thinking?: "adaptive" | "disabled";
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
    if (res.rows.length === 0) return { ...APPLYMATE_BACKING };

    const prefs = res.rows[0].preferences ?? {};
    const aiSettings = (prefs as Record<string, unknown>).aiSettings as
      | Record<string, unknown>
      | undefined;

    // Check per-feature override first. A user-owned model remains higher
    // priority than the platform route configured by administrators.
    const features = aiSettings?.features as
      | Record<string, AiConfig | null>
      | undefined;
    const featureCfg = features?.["autoApply"];
    const keys = aiSettings?.keys as Record<string, string> | undefined;
    if (featureCfg && typeof featureCfg === "object") return withUserKey(featureCfg, keys);

    const platform = await loadPlatformRoute(client, keys);
    if (platform) return platform;
    return withUserKey(APPLYMATE_BACKING, keys);
  } finally {
    client.release();
  }
}

function withUserKey(config: AiConfig, keys: Record<string, string> | undefined): AiConfig {
  return {
    ...config,
    apiKey: config.apiKey?.trim() || keys?.[config.provider]?.trim() || undefined,
  };
}

async function loadPlatformRoute(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  keys: Record<string, string> | undefined,
): Promise<AiConfig | null> {
  try {
    const routeResult = await client.query(
      `SELECT "defaultProvider", "defaultModel", "fallbackProvider", "fallbackModel"
       FROM "AiRouteConfig" WHERE "featureKey" = $1`,
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
      if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") continue;
      const providerResult = await client.query(
        `SELECT provider.key, provider."apiBase", provider."secretRef", provider.enabled, model.active
         FROM "AiProviderConfig" AS provider
         JOIN "AiModelConfig" AS model ON model."providerId" = provider.id
         WHERE provider.key = $1 AND model.model = $2`,
        [candidate.provider, candidate.model],
      );
      const row = providerResult.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.enabled !== true || row.active !== true) continue;
      const provider = candidate.provider as Provider;
      const apiKey = (typeof row.secretRef === "string" ? process.env[row.secretRef] : undefined)
        || keys?.[provider]?.trim()
        || getServerKey(provider);
      // Prefer a configured fallback when the primary provider has no usable
      // credential, while preserving a clear error for a single misconfigured route.
      if (!apiKey && hasFallback && index === 0) continue;
      return { provider, model: candidate.model, apiBase: String(row.apiBase ?? ""), apiKey };
    }
  } catch {
    // The platform AI tables are additive; older worker deployments use the
    // existing environment-backed configuration until migrations complete.
  }
  return null;
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
  config: AiConfig
): Promise<ChatResult> {
  const provider = config.provider;

  if (provider === "anthropic") {
    return callAnthropic(messages, config);
  }
  // MiniMax, OpenAI, DeepSeek, custom — all OpenAI-compatible
  return callOpenAICompat(messages, config);
}

// ── Provider implementations ──

async function callOpenAICompat(
  messages: ChatMessage[],
  config: AiConfig
): Promise<ChatResult> {
  const base = config.apiBase || DEFAULT_API_BASES[config.provider] || DEFAULT_API_BASES.minimax;
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

  const res = await fetch(`${base}/chat/completions`, {
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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
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

/** Convenience: call LLM and return only the text string */
export async function callLlmText(
  messages: ChatMessage[],
  config: AiConfig
): Promise<string> {
  const result = await callLlm(messages, config);
  return result.text;
}
