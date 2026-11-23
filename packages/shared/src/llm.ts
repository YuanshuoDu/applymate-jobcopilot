import { isSafeAiEndpoint } from "./safe-ai-endpoint.js";
import { pinnedFetch } from "./pinned-outbound.js";
import { recordSharedAiUsage, sharedAiUsageErrorCode } from "./ai-usage.js";
import { MINIMAX_DEFAULT_BASE_URL, resolveMiniMaxBaseUrl } from "./minimax.js";
import {
  APPLYMATE_BACKING,
  closeSharedPool,
  getServerKey,
  getWorkerAiPool,
  loadWorkerAgentAiRoute,
  loadWorkerAiConfig,
  resolveWorkerAiConfig,
  type AiConfig,
  type Provider,
  type WorkerAgentAiRoute,
} from "./llm-worker-config.js";

export { APPLYMATE_BACKING, closeSharedPool, loadWorkerAgentAiRoute, loadWorkerAiConfig, resolveWorkerAiConfig };
export type { AiConfig, Provider, WorkerAgentAiRoute };

type UsageRuntime = "web" | "worker" | "admin" | "unknown";

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

const DEFAULT_API_BASES: Record<Provider, string> = {
  minimax: MINIMAX_DEFAULT_BASE_URL,
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://api.z.ai/api/paas/v4",
  kimi: "https://api.moonshot.ai/v1",
  custom: "",
};

// ── LLM Call ──

/**
 * Call an LLM with chat messages and return the text response.
 * Supports MiniMax (OpenAI-compatible), OpenAI, Anthropic, DeepSeek.
 */
export async function callLlm(
  messages: ChatMessage[],
  config: AiConfig,
  usageContext?: { userId?: string; featureKey?: string; runtime?: UsageRuntime },
): Promise<ChatResult> {
  const provider = config.provider;
  const startedAt = Date.now();
  try {
    const result = provider === "anthropic"
      ? await callAnthropic(messages, config)
      : await callOpenAICompat(messages, config);
    if (process.env.NODE_ENV !== "test") await recordSharedAiUsage(getWorkerAiPool(), { ...usageContext, provider: result.provider, model: result.model, credentialSource: config.credentialSource ?? (config.apiKey ? "user" : "platform"), inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - startedAt, status: "success" });
    return result;
  } catch (error) {
    if (process.env.NODE_ENV !== "test") await recordSharedAiUsage(getWorkerAiPool(), { ...usageContext, provider, model: config.model, credentialSource: config.credentialSource ?? (config.apiKey ? "user" : "platform"), latencyMs: Date.now() - startedAt, status: "error", errorCode: sharedAiUsageErrorCode(error) });
    throw error;
  }
}

// ── Provider implementations ──

async function callOpenAICompat(
  messages: ChatMessage[],
  config: AiConfig
): Promise<ChatResult> {
  const key = config.apiKey || getServerKey(config.provider)
  const base = config.provider === "minimax"
    ? resolveMiniMaxBaseUrl({
        apiBase: config.apiBase,
        apiKey: key,
        environmentBaseUrl: process.env.MINIMAX_BASE_URL,
        environmentRegion: process.env.MINIMAX_REGION,
      })
    : config.apiBase || DEFAULT_API_BASES[config.provider];
  if (config.provider === "custom" && !isSafeAiEndpoint(base)) {
    throw new Error("Custom AI endpoint is not an allowed public HTTPS destination");
  }
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
    throw new Error(`LLM API error ${res.status} from ${config.provider}`);
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
    throw new Error(`Anthropic API error ${res.status}`);
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

/** Convenience: call LLM and return only the text string */
export async function callLlmText(
  messages: ChatMessage[],
  config: AiConfig,
  usageContext?: { userId?: string; featureKey?: string; runtime?: UsageRuntime },
): Promise<string> {
  const result = await callLlm(messages, config, usageContext);
  return result.text;
}
