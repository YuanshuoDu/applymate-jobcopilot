import type { PolicyHook, PolicyHookContext, PolicyHookResult, PolicyRule, PolicySnapshot } from "./types.js"

export const POLICY_MATRIX_HOOK = "matrix.role-tool-risk-domain"
export const POLICY_MATRIX_ORDER = 10_000

export function createPolicyMatrixHook(snapshot?: PolicySnapshot): PolicyHook {
  return {
    name: POLICY_MATRIX_HOOK,
    order: POLICY_MATRIX_ORDER,
    stage: "before_tool_use",
    evaluate: (context) => evaluateMatrix(snapshot, context),
  }
}

function evaluateMatrix(snapshot: PolicySnapshot | undefined, context: PolicyHookContext): PolicyHookResult {
  if (!snapshot) {
    if (context.tool.risk === "read" && context.tool.capabilities.includes("read")) {
      return { outcome: "allow", reasonCode: "default_read_only_allow", reason: "Read-only tools use the safe runtime baseline" }
    }
    return { outcome: "deny", reasonCode: "missing_policy", reason: "A policy is required before any write-capable tool can run" }
  }

  const rule = snapshot.rules.find((candidate) => matches(candidate, context))
  if (!rule) return { outcome: "deny", reasonCode: "no_matching_policy", reason: "No policy rule permits this role, tool, risk, and domain" }
  return { outcome: rule.outcome, reasonCode: rule.reasonCode, reason: rule.reason }
}

function matches(rule: PolicyRule, context: PolicyHookContext): boolean {
  if (!rule.roles.includes(context.actorRole)) return false
  if (rule.tools && !rule.tools.includes(context.tool.name)) return false
  if (rule.toolVersions && !rule.toolVersions.includes(context.tool.version)) return false
  if (rule.risks && !rule.risks.includes(context.tool.risk)) return false
  if (rule.domains && !rule.domains.includes(context.tool.domain)) return false
  return !rule.requiredCapabilities?.some((capability) => !context.capabilities.includes(capability))
}
