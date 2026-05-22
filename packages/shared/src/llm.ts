import pg from "pg";

// ── Types ──

export type Provider = "minimax" | "openai" | "anthropic" | "deepseek" | "custom";

export interface AiConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  apiBase?: string;
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
  model: "MiniMax-M2.7",
};

const DEFAULT_API_BASES: Record<Provider, string> = {
  minimax: "https://api.minimaxi.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
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

    if (!aiSettings) return { ...APPLYMATE_BACKING };

    // Check per-feature override
    const features = aiSettings.features as
      | Record<string, AiConfig | null>
      | undefined;
    const featureCfg = features?.["autoApply"];

    // Build base config
    const base = featureCfg ?? APPLYMATE_BACKING;

    // Resolve API key: feature.apiKey → keys[provider] → server env
    const keys = aiSettings.keys as Record<string, string> | undefined;
    const apiKey =
      base.apiKey?.trim() ||
      keys?.[base.provider]?.trim() ||
      undefined;

    return {
      provider: base.provider,
      model: base.model,
      apiKey,
      apiBase: (base as AiConfig).apiBase,
    };
  } finally {
    client.release();
  }
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

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 4096,
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
