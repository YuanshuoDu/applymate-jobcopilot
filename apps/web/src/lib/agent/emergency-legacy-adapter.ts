import type {
  LegacyModelFacade,
  ModelAdapter,
  ModelCapabilityProfile,
} from "@jobcopilot/agent-model"

export const EMERGENCY_LEGACY_MODE = "EMERGENCY_LEGACY_MODE" as const

export type EmergencyLegacyModeState =
  | { enabled: false; reason: "unset" | "invalid"; value?: string }
  | { enabled: true; reason: "enabled"; value: "true" }

export interface EmergencyLegacyAdapterOptions<TConfig> {
  facade: LegacyModelFacade<TConfig>
  config: TConfig
  profile: ModelCapabilityProfile
  env?: Readonly<Record<string, string | undefined>>
  adapterId?: string
}

export class EmergencyLegacyAdapterError extends Error {
  readonly code = "configuration_error" as const
  readonly recoverable = false
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = "EmergencyLegacyAdapterError"
  }
}

export function readEmergencyLegacyMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmergencyLegacyModeState {
  const value = env[EMERGENCY_LEGACY_MODE]
  if (value === undefined) return { enabled: false, reason: "unset" }
  if (value === "true") return { enabled: true, reason: "enabled", value }
  return { enabled: false, reason: "invalid", value }
}

export function isEmergencyLegacyModeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return readEmergencyLegacyMode(env).enabled
}

/**
 * Creates the legacy model adapter only after the emergency flag is validated.
 * The returned value is the typed adapter consumed by the AH2 model runtime;
 * no legacy path is reachable when the flag is absent or malformed.
 */
export function createEmergencyLegacyAdapter<TConfig>(
  options: EmergencyLegacyAdapterOptions<TConfig>,
): ModelAdapter {
  const state = readEmergencyLegacyMode(options.env)
  if (!state.enabled) throw disabledError(state)
  return options.facade.createAdapter(
    options.config,
    options.profile,
    options.adapterId ?? `emergency-legacy:${options.profile.provider}:${options.profile.model}`,
  )
}

function disabledError(state: Exclude<EmergencyLegacyModeState, { enabled: true }>): EmergencyLegacyAdapterError {
  const detail = state.reason === "unset" ? "is unset" : `has invalid value ${JSON.stringify(state.value)}`
  return new EmergencyLegacyAdapterError(`Emergency legacy mode ${detail}; legacy adapter is disabled`)
}
