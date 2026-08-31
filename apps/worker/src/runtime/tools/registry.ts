import {
  assertValid,
  ToolDefinitionSchema,
  schemaVersion,
  PolicyDomainSchema,
  type ToolCapability,
} from "@jobcopilot/agent-protocol"

import { ToolSchemaValidator } from "./schema-validator.js"
import type { PublicToolDefinition, RuntimeToolDefinition, ToolRisk } from "./types.js"

export type ToolRegistryErrorCode = "tool_not_found" | "tool_version_mismatch" | "duplicate_tool" | "invalid_definition"

export class ToolRegistryError extends Error {
  constructor(
    readonly code: ToolRegistryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ToolRegistryError"
  }
}

function registryKey(name: string, version: string): string {
  return `${name}@${version}`
}

function publicDefinition(definition: RuntimeToolDefinition): PublicToolDefinition {
  return {
    schemaVersion,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    capabilities: [...definition.capabilities],
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    risk: definition.risk,
    idempotency: definition.idempotency,
    timeoutMs: definition.timeoutMs,
    requiredCapabilities: [...definition.requiredCapabilities],
    domain: definition.domain,
  }
}

function protocolDefinition(definition: RuntimeToolDefinition) {
  return {
    schemaVersion,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    capabilities: [...definition.capabilities],
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, RuntimeToolDefinition>()
  readonly validators: ToolSchemaValidator

  constructor(definitions: readonly RuntimeToolDefinition[], validators = new ToolSchemaValidator()) {
    this.validators = validators
    for (const definition of definitions) this.register(definition)
  }

  register(definition: RuntimeToolDefinition): void {
    this.validateDefinition(definition)
    const key = registryKey(definition.name, definition.version)
    if (this.definitions.has(key)) throw new ToolRegistryError("duplicate_tool", `Tool ${key} is already registered`)
    this.definitions.set(key, definition)
  }

  resolve(name: string, version: string): RuntimeToolDefinition {
    const exact = this.definitions.get(registryKey(name, version))
    if (exact) return exact
    if ([...this.definitions.values()].some((definition) => definition.name === name)) {
      throw new ToolRegistryError("tool_version_mismatch", `Tool ${name} does not support version ${version}`)
    }
    throw new ToolRegistryError("tool_not_found", `Tool ${name} is not registered`)
  }

  /** Adapter for AH2-016 structured fallback validation before a call reaches the router. */
  validateArguments(name: string, input: unknown, version?: string): true | string {
    try {
      const definition = version ? this.resolve(name, version) : this.resolveForModel(name)
      if (containsModelUserId(input)) return "Tenant userId must be supplied by runtime scope"
      this.validators.validate(definition.inputSchema, input, `${name} input`)
      return true
    } catch (error: unknown) {
      return error instanceof Error ? error.message : "Tool arguments failed validation"
    }
  }

  list(): PublicToolDefinition[] {
    return [...this.definitions.values()].map(publicDefinition)
  }

  private validateDefinition(definition: RuntimeToolDefinition): void {
    try {
      assertValid(ToolDefinitionSchema, protocolDefinition(definition), "tool definition")
    } catch (error: unknown) {
      throw new ToolRegistryError("invalid_definition", error instanceof Error ? error.message : "Invalid tool definition")
    }
    const validRisks: ToolRisk[] = ["read", "draft_write", "internal_write", "external_write"]
    const validIdempotency = ["read_only", "idempotent", "requires_key", "non_repeatable"]
    if (!validRisks.includes(definition.risk) || !validIdempotency.includes(definition.idempotency) ||
      !Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 300_000 ||
      definition.requiredCapabilities.some((capability) => capability.length === 0)) {
      throw new ToolRegistryError("invalid_definition", `Tool ${definition.name}@${definition.version} has invalid runtime metadata`)
    }
    if (definition.risk === "read" && !definition.capabilities.includes("read" as ToolCapability)) {
      throw new ToolRegistryError("invalid_definition", `Read tool ${definition.name} must declare read capability`)
    }
    try {
      assertValid(PolicyDomainSchema, definition.domain, "tool domain")
    } catch (error: unknown) {
      throw new ToolRegistryError("invalid_definition", error instanceof Error ? error.message : "Invalid tool domain")
    }
  }

  private resolveForModel(name: string): RuntimeToolDefinition {
    const matches = [...this.definitions.values()].filter((definition) => definition.name === name)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new ToolRegistryError("tool_version_mismatch", `Tool ${name} requires an explicit version`)
    throw new ToolRegistryError("tool_not_found", `Tool ${name} is not registered`)
  }
}

export function containsModelUserId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsModelUserId)
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(([key, child]) => key === "userId" || containsModelUserId(child))
}
