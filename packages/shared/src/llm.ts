import pg from "pg";
import { isSafeAiEndpoint } from "./safe-ai-endpoint.js";

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
  minimax: "https://api.minimax.chat/v1",
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

    return resolveWorkerAiConfig(res.rows[0].preferences);
  } finally {
    client.release();
  }
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

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    redirect: "error",
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

/** Convenience: call LLM and return only the text string */
export async function callLlmText(
  messages: ChatMessage[],
  config: AiConfig
): Promise<string> {
  const result = await callLlm(messages, config);
  return result.text;
}
