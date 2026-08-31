export const MANAGED_FEATURES = {
  worker_discovery: { defaultEnabled: true },
  unattended_apply: { defaultEnabled: true },
  fantasticjobs_shadow: { defaultEnabled: false },
} as const

/**
 * Harness 2.0 controls are deliberately separate from legacy product
 * controls.  A missing row must leave the legacy path in place while the
 * future V2 path remains disabled until an explicitly reviewed rollout.
 */
export const AGENT_HARNESS_FEATURES = {
  AGENT_PROTOCOL_V2_DUAL_WRITE: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_EVENT_SSE_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_INPUT_QUEUE_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_CHAT_LOOP_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_TURN_WORKER_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_TOOL_KERNEL_V2: { defaultEnabled: false, fallback: 'deny-risk' },
  AGENT_POLICY_V2: { defaultEnabled: false, fallback: 'deny-risk' },
  AGENT_SUBAGENTS_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_CONTEXT_COMPACTION_V2: { defaultEnabled: false, fallback: 'legacy' },
  AGENT_BROWSER_TOOL_V2: { defaultEnabled: false, fallback: 'deny-risk' },
  AGENT_UI_TIMELINE_V2: { defaultEnabled: false, fallback: 'legacy' },
} as const

export type ManagedFeatureKey = keyof typeof MANAGED_FEATURES
export type AgentHarnessFeatureKey = keyof typeof AGENT_HARNESS_FEATURES
export const PLATFORM_FEATURES = { ...MANAGED_FEATURES, ...AGENT_HARNESS_FEATURES } as const
export type PlatformFeatureKey = keyof typeof PLATFORM_FEATURES
export type PlatformEnvironment = 'development' | 'staging' | 'production'
export type AgentHarnessFeatureFallback = 'legacy' | 'deny-risk'

export type ManagedFeatureOverride = {
  enabled: boolean
  rolloutPercent: number
  targetPlans: readonly string[]
  targetUserIds: readonly string[]
  status: string
  rollbackAt: Date | string | null
}

export type FeatureFlagEvaluationInput = {
  environment: PlatformEnvironment
  userId: string
  plan: string | null
  flag: ManagedFeatureOverride | null
  now?: Date
}

export type AgentHarnessFeatureHealth = {
  environment: PlatformEnvironment
  source: 'safe_defaults'
  allDefaultOff: boolean
  flags: Record<AgentHarnessFeatureKey, {
    enabled: boolean
    defaultEnabled: boolean
    fallback: AgentHarnessFeatureFallback
  }>
}

export function isManagedFeatureKey(value: string): value is ManagedFeatureKey {
  return Object.hasOwn(MANAGED_FEATURES, value)
}

export function isAgentHarnessFeatureKey(value: string): value is AgentHarnessFeatureKey {
  return Object.hasOwn(AGENT_HARNESS_FEATURES, value)
}

export function isPlatformFeatureKey(value: string): value is PlatformFeatureKey {
  return isManagedFeatureKey(value) || isAgentHarnessFeatureKey(value)
}

export function platformEnvironment(env: Record<string, string | undefined>): PlatformEnvironment {
  const configured = env.PLATFORM_ENV
  if (configured === 'development' || configured === 'staging' || configured === 'production') return configured
  return env.NODE_ENV === 'production' ? 'production' : 'development'
}

export function evaluateManagedFeature(key: ManagedFeatureKey, input: {
  environment: PlatformEnvironment
  userId: string
  plan: string | null
  flag: ManagedFeatureOverride | null
  now?: Date
}): boolean {
  return evaluateFeatureDefinition(MANAGED_FEATURES[key], key, input)
}

/**
 * Resolve a V2 control at a runtime boundary. Unknown keys are denied rather
 * than coerced into an enabled value, which protects callers that parse config
 * or database values before narrowing them to the typed catalog.
 */
export function evaluateAgentHarnessFeature(key: AgentHarnessFeatureKey | string, input: FeatureFlagEvaluationInput): boolean {
  if (!isAgentHarnessFeatureKey(key)) return false
  return evaluateFeatureDefinition(AGENT_HARNESS_FEATURES[key], key, input)
}

export function getAgentHarnessFeatureHealth(environment: PlatformEnvironment): AgentHarnessFeatureHealth {
  const flags = {} as AgentHarnessFeatureHealth['flags']
  for (const key of Object.keys(AGENT_HARNESS_FEATURES) as AgentHarnessFeatureKey[]) {
    const definition = AGENT_HARNESS_FEATURES[key]
    flags[key] = {
      enabled: evaluateAgentHarnessFeature(key, { environment, userId: 'health-check', plan: null, flag: null }),
      defaultEnabled: definition.defaultEnabled,
      fallback: definition.fallback,
    }
  }
  return {
    environment,
    source: 'safe_defaults',
    allDefaultOff: Object.values(flags).every((flag) => !flag.defaultEnabled && !flag.enabled),
    flags,
  }
}

function evaluateFeatureDefinition(
  definition: { defaultEnabled: boolean },
  key: string,
  input: FeatureFlagEvaluationInput,
): boolean {
  const fallback = definition.defaultEnabled
  const flag = input.flag
  const now = input.now ?? new Date()
  if (!flag || flag.status !== 'active' || isExpired(flag.rollbackAt, now)) return fallback
  if (!flag.enabled) return false
  if (flag.targetUserIds.includes(input.userId)) return true
  if (flag.targetPlans.length > 0 && (!input.plan || !flag.targetPlans.includes(input.plan))) return false
  if (flag.rolloutPercent <= 0) return false
  if (flag.rolloutPercent >= 100) return true
  return rolloutBucket(`${key}:${input.environment}:${input.userId}`) < flag.rolloutPercent
}

function isExpired(value: Date | string | null, now: Date): boolean {
  if (!value) return false
  const date = value instanceof Date ? value : new Date(value)
  return !Number.isNaN(date.getTime()) && date <= now
}

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  }
  return (hash >>> 0) % 100
}
