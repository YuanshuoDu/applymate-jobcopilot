import { AgentModelError } from "./errors.js"
import type {
  ModelAdapter,
  ModelCapabilityProfile,
  ModelCapabilityRequirement,
} from "./contracts.js"

export interface ModelTarget {
  provider: string
  model: string
}

export interface ModelAdapterResolver {
  resolve(target: ModelTarget, requirement?: ModelCapabilityRequirement): ModelAdapter
}

export class ModelAdapterRegistry implements ModelAdapterResolver {
  private readonly adapters = new Map<string, ModelAdapter>()

  register(adapter: ModelAdapter): this {
    if (!adapter.id.trim()) throw new AgentModelError({
      code: "configuration_error",
      message: "Model adapter id must not be empty",
    })
    if (this.adapters.has(adapter.id)) throw new AgentModelError({
      code: "configuration_error",
      message: `Model adapter already registered: ${adapter.id}`,
    })
    validateProfile(adapter.profile)
    this.adapters.set(adapter.id, adapter)
    return this
  }

  unregister(adapterId: string): boolean {
    return this.adapters.delete(adapterId)
  }

  get(adapterId: string): ModelAdapter | undefined {
    return this.adapters.get(adapterId)
  }

  list(): readonly ModelAdapter[] {
    return [...this.adapters.values()]
  }

  resolve(target: ModelTarget, requirement: ModelCapabilityRequirement = {}): ModelAdapter {
    const candidates = this.list()
      .filter((adapter) => matchesTarget(adapter.profile, target))
      .sort((left, right) => exactness(right.profile, target) - exactness(left.profile, target))
    const adapter = candidates[0]
    if (!adapter) throw new AgentModelError({
      code: "adapter_not_found",
      message: `No model adapter registered for ${target.provider}/${target.model}`,
      provider: target.provider,
      model: target.model,
      recoverable: true,
    })
    assertCapabilities(adapter.profile, requirement, target)
    return adapter
  }
}

function matchesTarget(profile: ModelCapabilityProfile, target: ModelTarget): boolean {
  return profile.provider === target.provider && (profile.model === target.model || profile.model === "*")
}

function exactness(profile: ModelCapabilityProfile, target: ModelTarget): number {
  return profile.model === target.model ? 1 : 0
}

function assertCapabilities(
  profile: ModelCapabilityProfile,
  requirement: ModelCapabilityRequirement,
  target: ModelTarget,
): void {
  for (const [key, required] of Object.entries(requirement)) {
    if (required === true && profile[key as keyof ModelCapabilityRequirement] !== true) {
      throw new AgentModelError({
        code: "unsupported_capability",
        message: `Model adapter ${profile.provider}/${profile.model} does not support ${key}`,
        provider: target.provider,
        model: target.model,
        recoverable: true,
      })
    }
  }
}

function validateProfile(profile: ModelCapabilityProfile): void {
  if (!profile.provider.trim() || !profile.model.trim()) throw new AgentModelError({
    code: "configuration_error",
    message: "Model adapter profile requires provider and model",
  })
  const limits = [profile.maxContextTokens, profile.maxOutputTokens]
  if (limits.some((limit) => limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))) {
    throw new AgentModelError({
      code: "configuration_error",
      message: `Model adapter profile has invalid token limits: ${profile.provider}/${profile.model}`,
    })
  }
}
