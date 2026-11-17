import type { PolicyRole, TenantScope } from "@jobcopilot/agent-protocol"
import type { TurnExecutionStepBudget } from "./turn-execution-types.js"
import type { TurnEngineToolResult } from "./turn-engine-tool-types.js"

export type TurnEngineToolExecutor = (input: {
  scope: TenantScope
  sessionId: string
  turnId: string
  stepId: string
  /** Runtime-owned current task; never accepted from model tool arguments. */
  taskId?: string
  /** Runtime-owned root task; never accepted from model tool arguments. */
  rootTaskId?: string
  /** Runtime-owned actor role used by the policy engine. */
  actorRole?: PolicyRole
  signal: AbortSignal
  capabilities?: readonly string[]
  /** Server-only provenance for the loop-injected final dependency wait; never part of model arguments. */
  serverGeneratedFinalDependencyWait?: Readonly<{ stepId: string; toolCallId: string }>
  call: { id: string; toolName: string; toolVersion: string; input: unknown }
} & TurnExecutionStepBudget) => Promise<TurnEngineToolResult>