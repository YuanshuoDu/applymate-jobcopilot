import type pg from "pg"
import type { PolicyRule, PolicySnapshot } from "@jobcopilot/agent-protocol"
import { PolicyEngine } from "@jobcopilot/agent-policy"

import { createWorkerUsageAuthorizer } from "../../queue/ai-usage-bridge.js"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { createWorkerToolRuntime } from "../tools/index.js"
import { createArtifactToolStore } from "../tools/artifact-tools.js"
import type { ArtifactToolExecutionContext } from "../tools/artifact-tools.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { durableLifecycleSink } from "../canonical-turn-runtime.js"
import { createPgTreeBudgetReservationStore } from "./tree-budget-store.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { createChildExecutor, type ChildExecutorOptions, type ChildToolRuntime } from "./child-executor.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { loadSelectedJobArtifactContext, resolveCoverLetterBase } from "./selected-job-artifact-context.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import type { ExecutionOwner, ExecutionOwnerFence } from "../execution-owner.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

export type ProductionChildRuntimeOptions = {
  readonly pool: pg.Pool
  readonly authorizeUsage?: ChildExecutorOptions["authorizeUsage"]
  readonly turnStore?: TurnEngineStore
  readonly treeBudget?: TreeBudgetReservationStore
  readonly modelRuntimeFactory?: ChildExecutorOptions["modelRuntimeFactory"]
  readonly toolRuntimeFactory?: ChildExecutorOptions["toolRuntimeFactory"]
  readonly mailboxReader?: ChildExecutorOptions["mailboxReader"]
  readonly resumeLoader?: ChildExecutorOptions["resumeLoader"]
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

const SUBAGENT_READ_RULE = {
  id: "canonical-subagent-read",
  roles: ["subagent"], risks: ["read"], requiredCapabilities: ["read"],
  outcome: "allow", reasonCode: "server_subagent_read_gate", reason: "The server enabled scoped child read tools",
} satisfies PolicyRule

function selectedJobId(task: SubagentTaskRecord): string | undefined {
  const selection = record(record(task.context).selectedJobPreparation)
  return Object.keys(selection).sort().join(",") === "jobId"
    && typeof selection.jobId === "string" && selection.jobId.trim().length > 0 && selection.jobId.length <= 256
    ? selection.jobId
    : undefined
}

function selectedJobPolicyRule(role: string, selectedJob: boolean): PolicyRule | undefined {
  if (!selectedJob) return undefined
  if (role === "writer") return {
    id: "canonical-selected-job-cover-letter-draft",
    roles: ["subagent"], tools: ["cover_letter.draft"], toolVersions: ["1"], risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["draft"],
    outcome: "allow", reasonCode: "server_selected_job_draft_gate", reason: "The server enabled the selected-job cover-letter draft tool",
  }
  if (role === "reviewer") return {
    id: "canonical-selected-job-artifact-review",
    roles: ["subagent"], tools: ["artifact.review"], toolVersions: ["1"], risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["review"],
    outcome: "allow", reasonCode: "server_selected_job_review_gate", reason: "The server enabled the bounded selected-job review receipt",
  }
  return undefined
}

function policy(value: unknown, task: SubagentTaskRecord, selectedJob: boolean): PolicyEngine {
  const snapshot = record(value)
  const hasMatrixField = Object.prototype.hasOwnProperty.call(snapshot, "version") || Object.prototype.hasOwnProperty.call(snapshot, "rules")
  const configured = typeof snapshot.version === "string" && Array.isArray(snapshot.rules)
    ? snapshot as unknown as PolicySnapshot
    : undefined
  if (hasMatrixField && !configured) return new PolicyEngine()
  const taskRule = selectedJobPolicyRule(task.role, selectedJob)
  const rules: PolicyRule[] = [...(configured?.rules ?? []), SUBAGENT_READ_RULE, ...(taskRule ? [taskRule] : [])]
  return new PolicyEngine({ snapshot: { version: configured?.version ?? "policy.v1", rules } })
}

function bindStore(store: TurnEngineStore): TurnExecutionStore {
  return {
    startStep: input => store.startStep({ ...withoutIdentity(input), owner: input.identity }),
    updateStep: input => store.updateStep({ ...withoutIdentity(input), owner: input.identity }),
    createItem: input => store.createItem({ ...withoutIdentity(input), owner: input.identity }),
    updateItem: input => store.updateItem({ ...withoutIdentity(input), owner: input.identity }),
    appendEvent: input => store.appendEvent({ ...withoutIdentity(input), owner: input.identity }),
    appendEvents: store.appendEvents ? (inputs) => store.appendEvents!(inputs.map(input => ({ ...withoutIdentity(input), owner: input.identity }))) : undefined,
  }
}

function withoutIdentity<T extends { identity: ExecutionOwnerFence }>(input: T): Omit<T, "identity"> {
  const { identity: _identity, ...rest } = input
  return rest
}

async function defaultTools(pool: pg.Pool, store: TurnEngineStore, task: SubagentTaskRecord, lease: SubagentLease, owner: ExecutionOwnerFence): Promise<ChildToolRuntime> {
  const executionOwner: ExecutionOwner = { kind: "task", lease }
  const selectedJobRole = task.role === "scout" || task.role === "analyst" || task.role === "writer" || task.role === "reviewer"
  const selectedJob = selectedJobRole ? selectedJobId(task) : undefined
  const selectedJobArtifactContext = selectedJob
    ? await loadSelectedJobArtifactContext(pool, task.userId, selectedJob)
    : undefined
  const selectedJobPreparation = selectedJobArtifactContext?.preparation
  const artifacts = selectedJobPreparation && (task.role === "writer" || task.role === "reviewer")
    ? createArtifactToolStore(pool)
    : undefined
  const coverLetterBase = task.role === "writer" && selectedJobPreparation && artifacts
    ? await resolveCoverLetterBase(artifacts, task.userId, selectedJobPreparation.jobId)
    : undefined
  const serverContext = selectedJobPreparation ? {
    selectedJobPreparation,
    ...(coverLetterBase ? { coverLetterBase } : {}),
  } : undefined
  const toolPolicy = policy(task.toolPolicySnapshot, task, Boolean(selectedJobPreparation))
  const runtime = createWorkerToolRuntime(pool, {
    sink: durableLifecycleSink(store, owner),
    resolveOwner: () => executionOwner,
  }, toolPolicy, undefined, undefined, artifacts ? { store: artifacts } : undefined)
  return {
    definitions: runtime.registry.list(), router: runtime.router,
    ...(selectedJobArtifactContext ? { selectedJobArtifactContext } : {}),
    ...(serverContext ? { serverContext } : {}),
    ...(selectedJobPreparation ? {
      executePrivateTool: async (context, request) => {
        const privateRead = task.role === "reviewer" && request.toolName === "artifact.version.read"
        const privateDraft = task.role === "writer" && request.toolName === "cover_letter.draft"
        const privateReview = task.role === "reviewer" && request.toolName === "artifact.review"
        if ((!privateRead && !privateDraft && !privateReview) || request.toolVersion !== "1" || context.actorRole !== "subagent") {
          throw new Error("private_artifact_read_unavailable")
        }
        const definition = runtime.registry.resolve(request.toolName, request.toolVersion)
        const validRead = definition.risk === "read" && definition.domain === "resume" && definition.idempotency === "read_only"
          && definition.capabilities.length === 1 && definition.capabilities[0] === "read" && definition.requiredCapabilities.length === 0
        const validDraft = definition.risk === "draft_write" && definition.domain === "resume" && definition.idempotency === "requires_key"
          && definition.capabilities.length === 2 && definition.capabilities.includes("read") && definition.capabilities.includes("write")
          && definition.requiredCapabilities.length === 0
        const validReview = validDraft && definition.name === "artifact.review" && definition.requiredCapabilities.length === 0
        if ((privateRead && !validRead) || ((privateDraft || privateReview) && !validDraft) || (privateReview && !validReview)) {
          throw new Error("private_artifact_read_unavailable")
        }
        const policyDecision = toolPolicy.evaluate({
          scope: context.scope, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
          toolCallId: request.id, actorRole: context.actorRole, capabilities: context.capabilities ?? [],
          tool: {
            name: definition.name, version: definition.version, risk: definition.risk, domain: definition.domain,
            capabilities: definition.capabilities, requiredCapabilities: definition.requiredCapabilities,
          },
          input: request.input,
        })
        if (policyDecision.outcome !== "allow") throw new Error("private_artifact_tool_policy_denied")
        const effectiveInput = policyDecision.safeInput === undefined ? request.input : policyDecision.safeInput
        const validation = runtime.registry.validateArguments(request.toolName, effectiveInput, request.toolVersion)
        if (validation !== true) throw new Error("private_artifact_read_input_invalid")
        const parentSignal = context.signal
        const controller = new AbortController()
        let timedOut = false
        const onAbort = () => controller.abort()
        if (parentSignal?.aborted) controller.abort()
        else parentSignal?.addEventListener("abort", onAbort, { once: true })
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, definition.timeoutMs)
        const executionContext: ArtifactToolExecutionContext = {
          scope: context.scope, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
          toolCallId: request.id, taskId: context.taskId, rootTaskId: context.rootTaskId, actorRole: context.actorRole,
          remainingTurnSteps: context.remainingTurnSteps, selectedJobPreparation: context.selectedJobPreparation, taskFence: context.taskFence,
          signal: controller.signal, capabilities: context.capabilities ?? [],
          reportProgress: async () => {
            if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
          },
        }
        try {
          if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
          const output = await definition.execute(executionContext, effectiveInput)
          if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
          runtime.registry.validators.validate(definition.outputSchema, output, `${request.toolName} output`)
          return { id: request.id, toolName: request.toolName, toolVersion: request.toolVersion, status: "completed" as const, output, errorCode: null }
        } finally {
          clearTimeout(timer)
          parentSignal?.removeEventListener("abort", onAbort)
        }
      },
    } : {}),
    validateArguments: (name, input, version) => runtime.registry.validateArguments(name, input, version),
  }
}

export function childExecutionEnabled(value = process.env.ENABLE_AGENT_CHILD_EXECUTION): boolean {
  return value === "1"
}

function defaultMailboxReader(pool: pg.Pool): ChildExecutorOptions["mailboxReader"] | undefined {
  // Keep lightweight construction fixtures usable; a real pg.Pool exposes
  // both methods and therefore gets the server-owned reader.
  const candidate = pool as unknown as { readonly connect?: unknown; readonly query?: unknown }
  if (typeof candidate.connect !== "function" || typeof candidate.query !== "function") return undefined
  return new PgCoordinationStore(pool)
}

function defaultResumeLoader(pool: pg.Pool): ChildExecutorOptions["resumeLoader"] | undefined {
  const candidate = pool as unknown as { readonly connect?: unknown }
  if (typeof candidate.connect !== "function") return undefined
  return lease => loadChildAttemptResume(pool, lease)
}

/** Build the production child seam only when the explicit feature flag is on. */
export function createProductionChildExecutor(options: ProductionChildRuntimeOptions): SubagentExecutor {
  const engineStore = options.turnStore ?? createPgTurnEngineStore(options.pool)
  const treeBudget = options.treeBudget ?? createPgTreeBudgetReservationStore(options.pool)
  const authorizeUsage = options.authorizeUsage ?? createWorkerUsageAuthorizer()
  const mailboxReader = options.mailboxReader ?? defaultMailboxReader(options.pool)
  const resumeLoader = options.resumeLoader ?? defaultResumeLoader(options.pool)
  return createChildExecutor({
    store: bindStore(engineStore), treeBudget, authorizeUsage,
    modelRuntimeFactory: options.modelRuntimeFactory,
    toolRuntimeFactory: options.toolRuntimeFactory ?? (({ task, lease, owner }) => defaultTools(options.pool, engineStore, task, lease, owner)),
    mailboxReader, resumeLoader,
  })
}

export function createOptionalProductionChildExecutor(options: ProductionChildRuntimeOptions & { readonly enabled?: boolean }): SubagentExecutor | undefined {
  const enabled = options.enabled ?? childExecutionEnabled()
  return enabled ? createProductionChildExecutor(options) : undefined
}
