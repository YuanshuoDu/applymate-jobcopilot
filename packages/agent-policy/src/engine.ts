import { assertValid, schemaVersion, PolicySnapshotSchema } from "@jobcopilot/agent-protocol"

import { createPolicyMatrixHook, POLICY_MATRIX_ORDER } from "./matrix.js"
import {
  MAX_POLICY_REWRITES,
  MISSING_POLICY_VERSION,
  POLICY_VERSION,
  policyScope,
  type PolicyEngineOptions,
  type PolicyEvaluationContext,
  type PolicyHook,
  type PolicyHookResult,
  type RuntimePolicyDecision,
} from "./types.js"

export type PolicyEngineErrorCode = "invalid_hook" | "duplicate_hook" | "invalid_policy_rule"

export class PolicyEngineError extends Error {
  constructor(readonly code: PolicyEngineErrorCode, message: string) {
    super(message)
    this.name = "PolicyEngineError"
  }
}

export class PolicyEngine {
  private readonly hooks: readonly PolicyHook[]
  private readonly supportedVersions: ReadonlySet<string>

  constructor(private readonly options: PolicyEngineOptions = {}) {
    this.supportedVersions = new Set(options.supportedVersions ?? [POLICY_VERSION])
    this.validateSnapshot()
    const matrix = createPolicyMatrixHook(options.snapshot)
    this.hooks = [...(options.hooks ?? []), matrix].sort(compareHooks)
    this.validateHooks(this.hooks)
  }

  evaluate(context: PolicyEvaluationContext): RuntimePolicyDecision {
    const version = this.options.snapshot?.version ?? MISSING_POLICY_VERSION
    const scope = policyScope(context)
    const appliedHooks: string[] = []
    if (this.options.snapshot && !this.supportedVersions.has(this.options.snapshot.version)) {
      return this.finish({
        schemaVersion,
        policyVersion: version,
        hook: "before_tool_use",
        outcome: "deny",
        reasonCode: "policy_version_unknown",
        reason: "The configured policy version is not supported by this runtime",
        scope,
        appliedHooks,
      })
    }

    const hookContext = immutableContext(context)
    let currentInput = clonePolicyValue(context.input)
    let rewriteCount = 0
    for (const hook of this.hooks) {
      appliedHooks.push(hook.name)
      const result = hook.evaluate({ ...hookContext, input: clonePolicyValue(currentInput) })
      if (result.rewrite) {
        if (result.outcome !== "rewrite_input") {
          return this.finish(this.denied(version, scope, "rewrite_invalid", "A policy rewrite must declare rewrite_input", appliedHooks))
        }
        if (result.rewrite.safeInput === undefined) {
          return this.finish(this.denied(version, scope, "rewrite_invalid", "A policy rewrite must include safeInput", appliedHooks))
        }
        rewriteCount += 1
        if (rewriteCount > MAX_POLICY_REWRITES) {
          return this.finish(this.denied(version, scope, "rewrite_limit", "Policy rewrites exceeded the deterministic limit", appliedHooks))
        }
        if (containsPermissionScopeKey(result.rewrite.safeInput)) {
          return this.finish(this.denied(version, scope, "rewrite_expands_permissions", "A policy rewrite cannot modify execution scope or permissions", appliedHooks))
        }
        currentInput = clonePolicyValue(result.rewrite.safeInput)
        continue
      }
      if (result.outcome === "rewrite_input") {
        return this.finish(this.denied(version, scope, "rewrite_invalid", "rewrite_input requires a safeInput payload", appliedHooks))
      }
      if (result.outcome && result.outcome !== "allow") {
        return this.finish(this.fromHook(version, scope, result, appliedHooks))
      }
      if (result.outcome === "allow" && hook.order === POLICY_MATRIX_ORDER) {
        return this.finish({
          ...this.fromHook(version, scope, result, appliedHooks),
          outcome: "allow",
          safeInput: rewriteCount > 0 ? currentInput : undefined,
        })
      }
    }

    return this.finish(this.denied(version, scope, "no_policy_decision", "The policy pipeline produced no terminal decision", appliedHooks))
  }

  private finish(decision: RuntimePolicyDecision): RuntimePolicyDecision {
    this.options.decisionSink?.append({
      schemaVersion,
      policyVersion: decision.policyVersion,
      hook: decision.hook,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      scope: decision.scope,
    })
    return decision
  }

  private fromHook(version: string, scope: RuntimePolicyDecision["scope"], result: PolicyHookResult, appliedHooks: readonly string[]): RuntimePolicyDecision {
    return {
      schemaVersion,
      policyVersion: version,
      hook: "before_tool_use",
      outcome: result.outcome ?? "deny",
      reasonCode: result.reasonCode?.trim() || "hook_denied",
      reason: result.reason?.trim() || "A policy hook denied the tool call",
      scope,
      appliedHooks,
    }
  }

  private denied(version: string, scope: RuntimePolicyDecision["scope"], reasonCode: string, reason: string, appliedHooks: readonly string[]): RuntimePolicyDecision {
    return { schemaVersion, policyVersion: version, hook: "before_tool_use", outcome: "deny", reasonCode, reason, scope, appliedHooks }
  }

  private validateSnapshot(): void {
    const snapshot = this.options.snapshot
    if (!snapshot) return
    try {
      assertValid(PolicySnapshotSchema, snapshot, "policy snapshot")
    } catch (error: unknown) {
      throw new PolicyEngineError("invalid_policy_rule", error instanceof Error ? error.message : "Invalid policy snapshot")
    }
    if (!snapshot.version.trim() || snapshot.rules.some((rule) => !rule.id.trim() || !rule.reasonCode.trim() || !rule.reason.trim() || rule.roles.length === 0)) {
      throw new PolicyEngineError("invalid_policy_rule", "Every policy rule needs an id, role, reason code, and reason")
    }
    const ids = new Set<string>()
    for (const rule of snapshot.rules) {
      if (ids.has(rule.id)) throw new PolicyEngineError("invalid_policy_rule", `Duplicate policy rule ${rule.id}`)
      ids.add(rule.id)
    }
  }

  private validateHooks(hooks: readonly PolicyHook[]): void {
    const names = new Set<string>()
    for (const hook of hooks) {
      if (!hook.name.trim() || hook.stage !== "before_tool_use" || !Number.isFinite(hook.order) || (hook.name !== "matrix.role-tool-risk-domain" && hook.order >= POLICY_MATRIX_ORDER)) {
        throw new PolicyEngineError("invalid_hook", `Invalid before_tool_use policy hook ${hook.name}`)
      }
      if (names.has(hook.name)) throw new PolicyEngineError("duplicate_hook", `Duplicate policy hook ${hook.name}`)
      names.add(hook.name)
    }
  }
}

function compareHooks(left: PolicyHook, right: PolicyHook): number {
  return left.order - right.order || left.name.localeCompare(right.name)
}

function containsPermissionScopeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPermissionScopeKey)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => {
    if (["userId", "sessionId", "turnId", "stepId", "toolCallId", "toolName", "toolVersion", "role", "risk", "domain", "capabilities"].includes(key)) return true
    return containsPermissionScopeKey(child)
  })
}

function immutableContext(context: PolicyEvaluationContext): PolicyEvaluationContext {
  const tool = Object.freeze({
    ...context.tool,
    capabilities: Object.freeze([...context.tool.capabilities]),
    requiredCapabilities: Object.freeze([...context.tool.requiredCapabilities]),
  })
  return Object.freeze({
    ...context,
    scope: Object.freeze({ ...context.scope }),
    capabilities: Object.freeze([...context.capabilities]),
    tool,
  })
}

function clonePolicyValue(value: unknown): unknown {
  return structuredClone(value)
}
