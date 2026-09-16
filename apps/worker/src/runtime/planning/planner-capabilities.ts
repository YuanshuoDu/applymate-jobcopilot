import { isPlainJsonObject } from "./goal-plan-contract.js"

export type PlannerCapabilityRegistry = {
  readonly list: (capabilities?: readonly string[]) => readonly unknown[]
}

export type PlannerCapabilityCatalog = {
  /** Tool names that are both server-allowed and currently registered. */
  readonly tools: readonly string[]
  /** Template ids exposed by currently registered tool definitions. */
  readonly templates: readonly string[]
}

export type PlannerCapabilityErrorCode = "planner_capability_unavailable" | "planner_capability_invalid"

export class PlannerCapabilityError extends Error {
  constructor(
    readonly code: PlannerCapabilityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PlannerCapabilityError"
  }
}

function requested(name: string, values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) {
    throw new PlannerCapabilityError("planner_capability_invalid", `Invalid planner ${name} allowlist`)
  }
  return [...new Set(values.map(value => value.trim()))]
}

function registered(registry: PlannerCapabilityRegistry, capabilities: readonly string[] | undefined): { tools: ReadonlySet<string>; templates: ReadonlySet<string> } {
  let definitions: readonly unknown[]
  try {
    definitions = registry.list(capabilities)
  } catch {
    throw new PlannerCapabilityError("planner_capability_unavailable", "Planner capability registry is unavailable")
  }
  if (!Array.isArray(definitions)) throw new PlannerCapabilityError("planner_capability_invalid", "Planner capability registry returned an invalid catalog")
  const tools = new Set<string>()
  const templates = new Set<string>()
  for (const definition of definitions) {
    if (!isPlainJsonObject(definition)) continue
    if (typeof definition.name !== "string" || !definition.name.trim()) continue
    tools.add(definition.name.trim())
    if (definition.template !== undefined) {
      if (typeof definition.template !== "string" || !definition.template.trim()) {
        throw new PlannerCapabilityError("planner_capability_invalid", "Planner capability registry contains an invalid template")
      }
      templates.add(definition.template.trim())
    }
  }
  return { tools, templates }
}

/**
 * Build the planner allowlists from the definitions the runtime can actually
 * resolve. The requested lists remain a server-owned upper bound; a stale
 * entry is removed before a plan can be accepted or persisted.
 */
export function derivePlannerCapabilityCatalog(
  registry: PlannerCapabilityRegistry,
  capabilities: readonly string[] | undefined,
  requestedTools: readonly string[],
  requestedTemplates: readonly string[],
): PlannerCapabilityCatalog {
  const tools = requested("tool", requestedTools)
  const templates = requested("template", requestedTemplates)
  const actual = registered(registry, capabilities)
  return Object.freeze({
    tools: Object.freeze(tools.filter(tool => actual.tools.has(tool))),
    templates: Object.freeze(templates.filter(template => actual.templates.has(template))),
  })
}
