import { Type, type Static } from '@sinclair/typebox'

import { IdSchema, NonEmptyTextSchema, SchemaVersionSchema } from './common.js'
import { ToolRiskSchema } from './tool.js'

export const PolicyHookNameSchema = Type.Union([
  Type.Literal('before_model_call'),
  Type.Literal('after_model_call'),
  Type.Literal('before_tool_use'),
  Type.Literal('after_tool_use'),
  Type.Literal('before_business_mutation'),
  Type.Literal('before_external_submission'),
  Type.Literal('before_context_compaction'),
  Type.Literal('before_final_response'),
])

export const PolicyOutcomeSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('deny'),
  Type.Literal('require_approval'),
  Type.Literal('require_user_input'),
  Type.Literal('rewrite_input'),
])

export const PolicyRoleSchema = Type.Union([
  Type.Literal('orchestrator'),
  Type.Literal('subagent'),
  Type.Literal('system'),
])

export const PolicyDomainSchema = Type.Union([
  Type.Literal('jobs'),
  Type.Literal('persona'),
  Type.Literal('resume'),
  Type.Literal('application'),
  Type.Literal('gmail'),
  Type.Literal('automation'),
  Type.Literal('coordination'),
  Type.Literal('unknown'),
])

export const PolicyScopeSchema = Type.Object({
  userId: IdSchema,
  sessionId: IdSchema,
  turnId: IdSchema,
  stepId: IdSchema,
  toolCallId: IdSchema,
  toolName: IdSchema,
  toolVersion: IdSchema,
  role: PolicyRoleSchema,
  domain: PolicyDomainSchema,
  risk: ToolRiskSchema,
}, { $id: 'agent.policy.scope', additionalProperties: false })

export const PolicyRuleOutcomeSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('deny'),
  Type.Literal('require_approval'),
  Type.Literal('require_user_input'),
])

export const PolicyRuleSchema = Type.Object({
  id: IdSchema,
  roles: Type.Array(PolicyRoleSchema, { minItems: 1 }),
  tools: Type.Optional(Type.Array(IdSchema)),
  toolVersions: Type.Optional(Type.Array(IdSchema)),
  risks: Type.Optional(Type.Array(ToolRiskSchema)),
  domains: Type.Optional(Type.Array(PolicyDomainSchema)),
  requiredCapabilities: Type.Optional(Type.Array(IdSchema)),
  outcome: PolicyRuleOutcomeSchema,
  reasonCode: IdSchema,
  reason: NonEmptyTextSchema,
}, { $id: 'agent.policy.rule', additionalProperties: false })

export const PolicySnapshotSchema = Type.Object({
  version: IdSchema,
  rules: Type.Array(PolicyRuleSchema),
}, { $id: 'agent.policy.snapshot', additionalProperties: false })

export const PolicyDecisionSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  policyVersion: IdSchema,
  hook: PolicyHookNameSchema,
  outcome: PolicyOutcomeSchema,
  reasonCode: IdSchema,
  reason: NonEmptyTextSchema,
  scope: PolicyScopeSchema,
}, { $id: 'agent.policy.decision', additionalProperties: false })

export type PolicyHookName = Static<typeof PolicyHookNameSchema>
export type PolicyOutcome = Static<typeof PolicyOutcomeSchema>
export type PolicyRole = Static<typeof PolicyRoleSchema>
export type PolicyDomain = Static<typeof PolicyDomainSchema>
export type PolicyScope = Static<typeof PolicyScopeSchema>
export type PolicyRuleOutcome = Static<typeof PolicyRuleOutcomeSchema>
export type PolicyRule = Static<typeof PolicyRuleSchema>
export type PolicySnapshot = Static<typeof PolicySnapshotSchema>
export type PolicyDecision = Static<typeof PolicyDecisionSchema>
