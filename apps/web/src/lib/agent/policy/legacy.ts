import {
  PolicyEngine,
  type PolicyHook,
  type PolicyHookContext,
  type PolicySnapshot,
  type RuntimePolicyDecision,
} from "@jobcopilot/agent-policy"
import type { PolicyDomain, PolicyRole, ToolCapability, ToolRisk } from "@jobcopilot/agent-protocol"

export interface LegacyPolicyAction {
  userId: string
  sessionId: string
  turnId: string
  stepId: string
  toolCallId: string
  toolName: string
  toolVersion?: string
  role?: PolicyRole
  domain: PolicyDomain
  risk: ToolRisk
  capabilities: readonly ToolCapability[]
  input?: Record<string, unknown>
}

export class LegacyPolicyError extends Error {
  constructor(
    readonly outcome: RuntimePolicyDecision["outcome"],
    readonly reasonCode: string,
    message: string,
  ) {
    super(message)
    this.name = "LegacyPolicyError"
  }
}

const LEGACY_POLICY_SNAPSHOT: PolicySnapshot = {
  version: "policy.v1",
  rules: [{
    id: "legacy-orchestrator-approved-boundary",
    roles: ["orchestrator", "system"],
    risks: ["read", "draft_write", "internal_write", "external_write"],
    domains: ["resume", "application", "gmail", "automation", "jobs", "persona", "coordination"],
    outcome: "allow",
    reasonCode: "legacy_entry_registered",
    reason: "Legacy entry points are admitted only after their deterministic guards pass",
  }],
}

const SENSITIVE_FACT_GATE: PolicyHook = {
  name: "legacy.confirmed-sensitive-facts",
  order: 100,
  stage: "before_tool_use",
  evaluate: ({ input }: PolicyHookContext) => {
    if (!isRecord(input) || input.unknownSensitiveFacts !== true) return { outcome: "allow" }
    if (input.confirmedAnswers === true) return { outcome: "allow" }
    return {
      outcome: "require_user_input",
      reasonCode: "sensitive_fact_confirmation_required",
      reason: "Unknown sensitive application facts require an explicit user answer before the agent can continue",
    }
  },
}

const RECEIPT_GATE: PolicyHook = {
  name: "legacy.scoped-receipt",
  order: 200,
  stage: "before_tool_use",
  evaluate: ({ input }: PolicyHookContext) => {
    if (!isRecord(input) || input.requiresReceipt !== true || input.receiptValidated === true) return { outcome: "allow" }
    return {
      outcome: "require_approval",
      reasonCode: "scoped_receipt_required",
      reason: "This action can change external or durable user state and requires a matching scoped approval receipt",
    }
  },
}

export function evaluateLegacyPolicy(action: LegacyPolicyAction): RuntimePolicyDecision {
  const input = {
    ...(action.input ?? {}),
    requiresReceipt: action.input?.requiresReceipt === true || action.risk === "external_write",
  }
  return new PolicyEngine({
    snapshot: LEGACY_POLICY_SNAPSHOT,
    hooks: [SENSITIVE_FACT_GATE, RECEIPT_GATE],
  }).evaluate({
    scope: { userId: action.userId },
    sessionId: action.sessionId,
    turnId: action.turnId,
    stepId: action.stepId,
    toolCallId: action.toolCallId,
    actorRole: action.role ?? "orchestrator",
    capabilities: action.capabilities,
    tool: {
      name: action.toolName,
      version: action.toolVersion ?? "legacy.v2",
      risk: action.risk,
      domain: action.domain,
      capabilities: action.capabilities,
      requiredCapabilities: action.capabilities,
    },
    input,
  })
}

export function requireLegacyPolicy(action: LegacyPolicyAction): RuntimePolicyDecision {
  const decision = evaluateLegacyPolicy(action)
  if (decision.outcome !== "allow") {
    throw new LegacyPolicyError(decision.outcome, decision.reasonCode, decision.reason)
  }
  return decision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
