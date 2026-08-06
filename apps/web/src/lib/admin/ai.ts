import type { ModelOption, Provider } from '@/lib/model-router'

export interface AiModelDto {
  id: string
  model: string
  label: string
  description?: string
  tier: string
  priceIn: number
  priceOut: number
  contextK: number
  active: boolean
}

export interface AiProviderDto {
  id: string
  key: string
  displayName: string
  apiBase: string
  secretRef?: string
  credentialConfigured: boolean
  enabled: boolean
  version: number
  models: AiModelDto[]
}

export interface AiProviderInput { key: string; displayName: string; apiBase: string; secretRef?: string; enabled?: boolean }
export interface AiModelInput { model: string; label: string; description?: string; tier: string; priceIn: number; priceOut: number; contextK: number; active?: boolean }

export function toAiProviderDto(input: unknown): AiProviderDto {
  const row = record(input)
  const models = Array.isArray(row.models) ? row.models.map(toAiModelDto) : []
  return { id: text(row.id), key: text(row.key), displayName: text(row.displayName), apiBase: text(row.apiBase), secretRef: optionalText(row.secretRef), credentialConfigured: row.credentialConfigured === true, enabled: row.enabled !== false, version: integer(row.version, 1), models }
}

export function toAiModelDto(input: unknown): AiModelDto {
  const row = record(input)
  return { id: text(row.id), model: text(row.model), label: text(row.label), description: optionalText(row.description), tier: text(row.tier), priceIn: numberValue(row.priceIn), priceOut: numberValue(row.priceOut), contextK: integer(row.contextK, 128), active: row.active !== false }
}

export function validateAiProvider(input: unknown): AiProviderInput {
  const row = record(input)
  const key = boundedPattern(row.key, /^[a-z][a-z0-9_-]{1,31}$/, 'Provider key')
  const displayName = requiredText(row.displayName, 'Provider display name', 80)
  const apiBase = requiredText(row.apiBase, 'Provider API base', 300)
  let parsed: URL
  try { parsed = new URL(apiBase) } catch { throw new Error('Provider API base must be a URL') }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('Provider API base must use HTTPS')
  const secretRef = row.secretRef === undefined || row.secretRef === null || row.secretRef === '' ? undefined : boundedPattern(row.secretRef, /^[A-Z][A-Z0-9_]{2,63}$/, 'Secret reference')
  const enabled = row.enabled === undefined ? true : row.enabled
  if (typeof enabled !== 'boolean') throw new Error('Provider enabled flag is invalid')
  return { key, displayName, apiBase: parsed.toString().replace(/\/$/, ''), secretRef, enabled }
}

export function validateAiModel(input: unknown): AiModelInput {
  const row = record(input)
  const model = requiredText(row.model, 'Model identifier', 120)
  const label = requiredText(row.label, 'Model label', 120)
  const description = optionalText(row.description)
  const tier = boundedPattern(row.tier, /^(fast|standard|premium)$/, 'Model tier')
  const priceIn = nonNegativeNumber(row.priceIn, 'Input price')
  const priceOut = nonNegativeNumber(row.priceOut, 'Output price')
  const contextK = boundedInteger(row.contextK, 'Context window')
  const active = row.active === undefined ? true : row.active
  if (typeof active !== 'boolean') throw new Error('Model active flag is invalid')
  return { model, label, description, tier, priceIn, priceOut, contextK, active }
}

export function validateAiRoute(input: unknown, activeModels: ReadonlySet<string>) {
  const row = record(input)
  const featureKey = boundedPattern(row.featureKey, /^[a-z][a-zA-Z0-9_.-]{1,63}$/, 'Feature key')
  const defaultProvider = boundedPattern(row.defaultProvider, /^[a-z][a-z0-9_-]{1,31}$/, 'Default provider')
  const defaultModel = requiredText(row.defaultModel, 'Default model', 120)
  if (!activeModels.has(`${defaultProvider}/${defaultModel}`)) throw new Error('Default route must target an active model')
  const fallbackProvider = optionalText(row.fallbackProvider)
  const fallbackModel = optionalText(row.fallbackModel)
  if ((fallbackProvider && !fallbackModel) || (!fallbackProvider && fallbackModel)) throw new Error('Fallback provider and model must be provided together')
  if (fallbackProvider && !activeModels.has(`${fallbackProvider}/${fallbackModel}`)) throw new Error('Fallback route must target an active model')
  return { featureKey, defaultProvider, defaultModel, fallbackProvider, fallbackModel }
}

export function modelOptionToInput(option: ModelOption): AiModelInput { return { model: option.model, label: option.label, description: option.description, tier: option.tier, priceIn: option.priceIn, priceOut: option.priceOut, contextK: option.contextK, active: true } }

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function requiredText(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${field} is required`); return value.trim() }
function optionalText(value: unknown, max = 500): string | undefined { if (value === undefined || value === null || value === '') return undefined; if (typeof value !== 'string' || value.trim().length > max) throw new Error('Text value is too long'); return value.trim() }
function boundedPattern(value: unknown, pattern: RegExp, field: string): string { if (typeof value !== 'string' || !pattern.test(value.trim())) throw new Error(`${field} is invalid`); return value.trim() }
function nonNegativeNumber(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`${field} must be non-negative`); return value }
function boundedInteger(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${field} must be a bounded integer`); return value }
function integer(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) ? value : fallback }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
