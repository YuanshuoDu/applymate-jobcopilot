import type { RuntimeToolDefinition } from "./tools/types.js"
import type { ProductionAgentFlags } from "./production-agent-flags.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import { objectiveTailorWaveBudgetDisposition } from "./subagents/objective-tailor-wave-profile.js"
import { createAgentTailorTool, registerAgentTailorTool } from "./tools/agent-tailor.js"
import { createAgentTailorWaveTool } from "./tools/agent-tailor-wave.js"
import type { ReconciliationFenceOptions } from "./tools/steering-reconciliation.js"

export type ObjectiveTailorToolVersion = "1" | "2"
type Registry = Readonly<{ register?: (definition: RuntimeToolDefinition) => void }>

/** Registers exactly the version authorized by this Turn's persisted profile and runtime gates. */
export function registerCanonicalObjectiveTailorTool(input: Readonly<{
  registry: Registry
  commandPort?: TaskGraphCommandPort
  budgetSnapshot: unknown
  rootEligible: boolean
  flags?: Pick<ProductionAgentFlags, "objectiveTailorEnabled" | "objectiveTailorWavesEnabled">
  options: ReconciliationFenceOptions
}>): ObjectiveTailorToolVersion | undefined {
  const port = input.commandPort
  const v1Available = typeof port?.readObjectiveTailorCatalog === "function" && typeof port.appendObjectiveTailor === "function"
  const v2Available = typeof port?.readObjectiveTailorWaveCatalog === "function"
    && typeof port.appendObjectiveTailorWave === "function" && typeof port.appendObjectiveTailorCorrection === "function"
  const profile = objectiveTailorWaveBudgetDisposition(input.budgetSnapshot)
  if (!input.registry.register || !input.rootEligible || profile === "invalid") return undefined
  if (profile === "wave") {
    if (input.flags?.objectiveTailorWavesEnabled !== true || !v2Available || !port) return undefined
    input.registry.register(createAgentTailorWaveTool(port, input.options))
    return "2"
  }
  if (input.flags?.objectiveTailorEnabled !== true || !v1Available || !port) return undefined
  if (!registerAgentTailorTool(input.registry, port, () => true, input.options)) return undefined
  return "1"
}

/** Only `agent.tailor` has a profile-selected version; mixed visibility is an explicit invalid state. */
export function objectiveTailorVersionFromRootTools(value: readonly unknown[]): "1" | "2" | "ambiguous" | undefined {
  const matches = value.flatMap(item => {
    const definition = record(item)
    return definition?.name === "agent.tailor" ? [definition.version] : []
  })
  if (matches.length === 0) return undefined
  if (matches.length !== 1) return "ambiguous"
  return matches[0] === "1" || matches[0] === "2" ? matches[0] : "ambiguous"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
