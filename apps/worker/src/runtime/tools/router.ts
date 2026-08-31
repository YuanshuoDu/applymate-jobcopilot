import { ToolSchemaValidationError } from "./schema-validator.js"
import { containsModelUserId, ToolRegistryError, type ToolRegistry } from "./registry.js"
import { ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import { PolicyEngine, type RuntimePolicyDecision } from "../policy/index.js"
import type {
  RuntimeToolDefinition,
  ToolCallRequest,
  ToolExecutionResult,
  ToolRouterContext,
  ToolExecutionContext,
} from "./types.js"

export type ToolRouterErrorCode = "runtime_scope_error" | "capability_denied" | "idempotency_conflict" | "timeout" | "cancelled" | "tool_execution_failed" | "policy_denied" | "policy_requires_approval" | "policy_requires_user_input" | "policy_version_unknown" | "policy_rewrite_expands_permissions"

export class ToolRouterError extends Error {
  constructor(readonly code: ToolRouterErrorCode, message: string) {
    super(message)
    this.name = "ToolRouterError"
  }
}

interface LedgerEntry {
  readonly fingerprint: string
  readonly promise: Promise<ToolExecutionResult>
}

export class ToolRouter {
  private readonly ledger = new Map<string, LedgerEntry>()

  constructor(
    private readonly registry: ToolRegistry,
    private readonly lifecycle: ToolLifecycle,
    private readonly policy: PolicyEngine = new PolicyEngine(),
  ) {}

  execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> {
    const key = `${context.scope.userId}:${context.sessionId}:${context.turnId}:${context.stepId}:${request.id}`
    const fingerprint = stableJson({ toolName: request.toolName, toolVersion: request.toolVersion, input: request.input })
    const existing = this.ledger.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.resolve(this.failure(request, "idempotency_conflict"))
      return existing.promise
    }
    const promise = this.run(context, request)
    this.ledger.set(key, { fingerprint, promise })
    return promise
  }

  private async run(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> {
    const call: LifecycleCall = { ...context, id: request.id, toolName: request.toolName, toolVersion: request.toolVersion }
    await this.lifecycle.started(call, request.input)
    try {
      if (!context.scope.userId.trim() || containsModelUserId(request.input)) {
        throw new ToolRouterError("runtime_scope_error", "Tenant userId must be supplied by runtime scope")
      }
      const definition = this.registry.resolve(request.toolName, request.toolVersion)
      this.assertCapabilities(definition, context.capabilities ?? [])
      this.registry.validators.validate(definition.inputSchema, request.input, `${request.toolName} input`)
      const policyDecision = this.policy.evaluate({
        scope: context.scope,
        sessionId: context.sessionId,
        turnId: context.turnId,
        stepId: context.stepId,
        toolCallId: request.id,
        actorRole: context.actorRole ?? "orchestrator",
        capabilities: context.capabilities ?? [],
        tool: {
          name: definition.name,
          version: definition.version,
          risk: definition.risk,
          domain: definition.domain,
          capabilities: definition.capabilities,
          requiredCapabilities: definition.requiredCapabilities,
        },
        input: request.input,
      })
      this.assertPolicy(policyDecision)
      const effectiveInput = policyDecision.safeInput === undefined ? request.input : policyDecision.safeInput
      if (containsModelUserId(effectiveInput)) throw new ToolRouterError("policy_rewrite_expands_permissions", "A policy rewrite attempted to override tenant scope")
      this.registry.validators.validate(definition.inputSchema, effectiveInput, `${request.toolName} rewritten input`)
      const execution = this.createExecution(context, request, definition, effectiveInput)
      const output = await execution.run()
      this.registry.validators.validate(definition.outputSchema, output, `${request.toolName} output`)
      const safeOutput = await this.lifecycle.completed(call, output)
      return { ...request, status: "completed", output: safeOutput, errorCode: null }
    } catch (error: unknown) {
      const code = this.errorCode(error)
      const phase = code === "cancelled" || code === "timeout" ? "cancelled" : "failed"
      await this.lifecycle.failed(call, phase, code, { message: error instanceof Error ? error.message : "Tool execution failed" })
      return { ...request, status: phase === "cancelled" ? "cancelled" : "failed", errorCode: code }
    }
  }

  private createExecution(context: ToolRouterContext, request: ToolCallRequest, definition: RuntimeToolDefinition, input: unknown): { run(): Promise<unknown> } {
    const controller = new AbortController()
    let timedOut = false
    const parent = context.signal
    const onAbort = () => controller.abort()
    if (parent?.aborted) controller.abort()
    else parent?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, definition.timeoutMs)
    const executionContext: ToolExecutionContext = {
      scope: context.scope,
      sessionId: context.sessionId,
      turnId: context.turnId,
      stepId: context.stepId,
      signal: controller.signal,
      capabilities: context.capabilities ?? [],
      reportProgress: async (progress) => {
        if (controller.signal.aborted) throw new ToolRouterError(timedOut ? "timeout" : "cancelled", "Tool execution was interrupted")
        await this.lifecycle.progress({ ...context, id: request.id, toolName: request.toolName, toolVersion: request.toolVersion }, progress)
      },
    }
    return {
      async run() {
        try {
          if (controller.signal.aborted) throw new ToolRouterError(timedOut ? "timeout" : "cancelled", "Tool execution was interrupted")
          return await definition.execute(executionContext, input)
        } catch (error: unknown) {
          if (controller.signal.aborted) throw new ToolRouterError(timedOut ? "timeout" : "cancelled", "Tool execution was interrupted")
          throw error
        } finally {
          clearTimeout(timer)
          parent?.removeEventListener("abort", onAbort)
        }
      },
    }
  }

  private assertCapabilities(definition: RuntimeToolDefinition, capabilities: readonly string[]): void {
    const missing = definition.requiredCapabilities.filter((capability) => !capabilities.includes(capability))
    if (missing.length > 0) throw new ToolRouterError("capability_denied", `Missing tool capabilities: ${missing.join(", ")}`)
  }

  private assertPolicy(decision: RuntimePolicyDecision): void {
    if (decision.outcome === "allow") return
    if (decision.reasonCode === "policy_version_unknown") throw new ToolRouterError("policy_version_unknown", decision.reason)
    if (decision.reasonCode === "rewrite_expands_permissions") throw new ToolRouterError("policy_rewrite_expands_permissions", decision.reason)
    if (decision.outcome === "require_approval") throw new ToolRouterError("policy_requires_approval", decision.reason)
    if (decision.outcome === "require_user_input") throw new ToolRouterError("policy_requires_user_input", decision.reason)
    throw new ToolRouterError("policy_denied", decision.reason)
  }

  private errorCode(error: unknown): string {
    if (error instanceof ToolSchemaValidationError) return error.code
    if (error instanceof ToolRegistryError) return error.code
    if (error instanceof ToolRouterError) return error.code
    return "tool_execution_failed"
  }

  private failure(request: ToolCallRequest, errorCode: string): ToolExecutionResult {
    return { ...request, status: errorCode === "cancelled" || errorCode === "timeout" ? "cancelled" : "failed", errorCode }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
