export type PlanEntitlementKind = 'boolean' | 'limit' | 'unlimited' | 'text'

export type EntitlementOption = { value: string; label: string }

export type EntitlementDefinition = {
  key: string
  label: string
  kind: PlanEntitlementKind
  options?: readonly EntitlementOption[]
  defaultUnit?: 'month' | ''
}

export type PlanEntitlementDraft = {
  id: string
  key: string
  kind: PlanEntitlementKind
  value: number | string
  unit: 'month' | ''
}

export const PLAN_ENTITLEMENT_DEFINITIONS: readonly EntitlementDefinition[] = [
  { key: 'applications', label: 'Applications', kind: 'limit', defaultUnit: 'month' },
  { key: 'ai_credits', label: 'AI credits', kind: 'limit' },
  { key: 'job_discovery', label: 'Job discovery', kind: 'limit' },
  { key: 'cover_letter', label: 'Cover letters', kind: 'limit' },
  { key: 'seats', label: 'Team seats', kind: 'limit' },
  { key: 'tracker', label: 'Job tracker', kind: 'limit' },
  { key: 'cv', label: 'CV tailoring', kind: 'text', options: [{ value: 'basic', label: 'Basic' }, { value: 'tailoring', label: 'Tailoring' }] },
  { key: 'extension', label: 'Browser extension', kind: 'text', options: [{ value: 'popup', label: 'Popup' }, { value: 'sidebar', label: 'Sidebar' }] },
  { key: 'cover_letters', label: 'Cover letter quality', kind: 'text', options: [{ value: 'basic', label: 'Basic' }, { value: 'ai', label: 'AI' }] },
  { key: 'gmail', label: 'Gmail integration', kind: 'text', options: [{ value: 'connected', label: 'Connected' }] },
  { key: 'support', label: 'Support level', kind: 'text', options: [{ value: 'priority', label: 'Priority' }, { value: 'dedicated', label: 'Dedicated' }] },
  { key: 'plan', label: 'Included plan', kind: 'text', options: [{ value: 'pro', label: 'Pro' }] },
  { key: 'jobs', label: 'Shared jobs', kind: 'text', options: [{ value: 'shared', label: 'Shared' }] },
  { key: 'analytics', label: 'Analytics', kind: 'text', options: [{ value: 'dashboard', label: 'Dashboard' }] },
  { key: 'ai', label: 'AI model access', kind: 'text', options: [{ value: 'custom_model', label: 'Custom model' }] },
  { key: 'auto_apply', label: 'Auto-apply', kind: 'boolean' },
  { key: 'tailored_resume', label: 'Tailored resume', kind: 'boolean' },
  { key: 'gmail_tracking', label: 'Gmail tracking', kind: 'boolean' },
  { key: 'api_access', label: 'API access', kind: 'boolean' },
]

const keyPattern = /^[a-z][a-z0-9_.-]{1,63}$/

export function getEntitlementDefinition(key: string) {
  return PLAN_ENTITLEMENT_DEFINITIONS.find(item => item.key === key)
}

export function createEntitlementDraft(key = 'auto_apply', id = `entitlement-${Date.now()}`): PlanEntitlementDraft {
  const definition = getEntitlementDefinition(key)
  const kind = definition?.kind ?? 'boolean'
  const value = kind === 'limit' ? 0 : definition?.options?.[0]?.value ?? ''
  return { id, key, kind, value, unit: definition?.defaultUnit ?? '' }
}

export function parseEntitlement(value: string, index = 0): PlanEntitlementDraft {
  const separator = value.indexOf(':')
  const key = (separator < 0 ? value : value.slice(0, separator)).trim()
  const suffix = separator < 0 ? '' : value.slice(separator + 1).trim()
  if (!suffix) return { ...createEntitlementDraft(key, `entitlement-${index}`), kind: 'boolean', value: '', unit: '' }
  if (suffix === 'unlimited') return { ...createEntitlementDraft(key, `entitlement-${index}`), kind: 'unlimited', value: '', unit: '' }
  const limit = suffix.match(/^(\d+)(?:\/(month))?$/)
  if (limit) return { ...createEntitlementDraft(key, `entitlement-${index}`), kind: 'limit', value: Number(limit[1]), unit: limit[2] === 'month' ? 'month' : '' }
  return { ...createEntitlementDraft(key, `entitlement-${index}`), kind: 'text', value: suffix, unit: '' }
}

export function parseEntitlements(values: readonly string[]) {
  return values.map((value, index) => parseEntitlement(value, index))
}

export function encodeEntitlement(draft: PlanEntitlementDraft): string {
  const key = draft.key.trim()
  if (!keyPattern.test(key)) throw new Error('Permission key must use lowercase letters, numbers, dots, dashes or underscores.')
  if (draft.kind === 'boolean') return key
  if (draft.kind === 'unlimited') return `${key}:unlimited`
  if (draft.kind === 'limit') {
    if (typeof draft.value !== 'number' || !Number.isInteger(draft.value) || draft.value < 0) throw new Error(`${key} must have a non-negative whole-number limit.`)
    return `${key}:${draft.value}${draft.unit === 'month' ? '/month' : ''}`
  }
  const value = String(draft.value).trim()
  if (!value || value.includes(':')) throw new Error(`${key} must have one valid value.`)
  return `${key}:${value}`
}

export function encodeEntitlements(drafts: readonly PlanEntitlementDraft[]) {
  const keys = drafts.map(draft => draft.key.trim())
  if (new Set(keys).size !== keys.length) throw new Error('Each permission can only be added once to a plan.')
  return drafts.map(encodeEntitlement)
}
