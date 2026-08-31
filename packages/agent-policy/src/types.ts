import type {
  PolicyDecision as AgentPolicyDecision,
  PolicyDomain,
  PolicyOutcome,
  PolicyRole,
  PolicyRule as ProtocolPolicyRule,
  PolicySnapshot as ProtocolPolicySnapshot,
  PolicyScope,
  TenantScope,
  ToolCapability,
  ToolRisk,
} from "@jobcopilot/agent-protocol"

export const POLICY_VERSION = "policy.v1"
export const MISSING_POLICY_VERSION = "policy.v1-missing-default"
export const MAX_POLICY_REWRITES = 3

export type PolicyRuleOutcome = Exclude<PolicyOutcome, "rewrite_input">

export interface PolicyToolDescriptor {
  readonly name: string
  readonly version: string
  readonly risk: ToolRisk
  readonly domain: PolicyDomain
  readonly capabilities: readonly ToolCapability[]
  readonly requiredCapabilities: readonly string[]
}

export interface PolicyEvaluationContext {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly toolCallId: string
  readonly actorRole: PolicyRole
  readonly capabilities: readonly string[]
  readonly tool: PolicyToolDescriptor
  readonly input: unknown
}

export type PolicyRule = ProtocolPolicyRule
export type PolicySnapshot = ProtocolPolicySnapshot

export interface PolicyRewrite {
  /** Rewrites are deliberately input-only; scope, role, tool, risk, and domain are immutable. */
  readonly safeInput: unknown
}

export interface PolicyHookContext extends PolicyEvaluationContext {
  readonly input: unknown
}

export interface PolicyHookResult {
  readonly outcome?: PolicyOutcome
  readonly reasonCode?: string
  readonly reason?: string
  readonly rewrite?: PolicyRewrite
}

export interface PolicyHook {
  readonly name: string
  readonly order: number
  readonly stage: "before_tool_use"
  evaluate(context: PolicyHookContext): PolicyHookResult
}

export interface PolicyDecisionSink {
  append(decision: AgentPolicyDecision): void
}

export interface RuntimePolicyDecision extends AgentPolicyDecision {
  readonly safeInput?: unknown
  readonly appliedHooks: readonly string[]
}

export interface PolicyEngineOptions {
  readonly snapshot?: PolicySnapshot
  readonly hooks?: readonly PolicyHook[]
  readonly decisionSink?: PolicyDecisionSink
  readonly supportedVersions?: readonly string[]
}

export function policyScope(context: PolicyEvaluationContext): PolicyScope {
  return {
    userId: context.scope.userId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    stepId: context.stepId,
    toolCallId: context.toolCallId,
    toolName: context.tool.name,
    toolVersion: context.tool.version,
    role: context.actorRole,
    domain: context.tool.domain,
    risk: context.tool.risk,
  }
}
