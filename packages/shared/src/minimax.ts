/**
 * MiniMax regional endpoints.
 *
 * Deployment-level environment overrides intentionally take precedence over
 * persisted provider settings. This lets an operator move a platform key to
 * the matching region without rewriting every saved route.
 */

export type MiniMaxRegion = "cn" | "international"

export const MINIMAX_CN_OPENAI_BASE_URL = "https://api.minimax.cn/v1"
export const MINIMAX_CN_ANTHROPIC_BASE_URL = "https://api.minimax.cn/anthropic"
export const MINIMAX_INTERNATIONAL_OPENAI_BASE_URL = "https://api.minimax.io/v1"
export const MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic"

export const MINIMAX_DEFAULT_BASE_URL = MINIMAX_INTERNATIONAL_OPENAI_BASE_URL
export const MINIMAX_DEFAULT_ANTHROPIC_BASE_URL = MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL

export function parseMiniMaxRegion(value: string | undefined): MiniMaxRegion | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "cn" || normalized === "china") return "cn"
  if (normalized === "international" || normalized === "global" || normalized === "intl") return "international"
  return undefined
}

export function miniMaxOpenAiBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? MINIMAX_CN_OPENAI_BASE_URL : MINIMAX_INTERNATIONAL_OPENAI_BASE_URL
}

export function miniMaxAnthropicBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? MINIMAX_CN_ANTHROPIC_BASE_URL : MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL
}

export interface MiniMaxBaseUrlOptions {
  baseUrl?: string
  apiBase?: string
  region?: string
  environmentBaseUrl?: string
  environmentRegion?: string
}

/**
 * Resolve the OpenAI-compatible MiniMax endpoint.
 *
 * MINIMAX_BASE_URL and MINIMAX_REGION are deployment overrides. Explicit
 * config is used next, followed by the international endpoint for backwards
 * compatibility. Trailing slashes are removed so callers can append paths.
 */
export function resolveMiniMaxBaseUrl(options: MiniMaxBaseUrlOptions = {}): string {
  const environmentBase = normalizeBaseUrl(options.environmentBaseUrl)
  if (environmentBase) return environmentBase

  const environmentRegion = parseMiniMaxRegion(options.environmentRegion)
  if (environmentRegion) return miniMaxOpenAiBaseUrl(environmentRegion)

  const configuredBase = normalizeBaseUrl(options.baseUrl ?? options.apiBase)
  if (configuredBase) return configuredBase

  const configuredRegion = parseMiniMaxRegion(options.region)
  return configuredRegion ? miniMaxOpenAiBaseUrl(configuredRegion) : MINIMAX_DEFAULT_BASE_URL
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, "")
  return normalized || undefined
}
