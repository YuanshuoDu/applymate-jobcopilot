import type pg from "pg"
import { Buffer } from "node:buffer"
import { digestNativeVerificationValue } from "./native-verification-contract.js"
import { transaction } from "./pg-store-persistence.js"
import { lockTaskGraphScope, loadTaskGraph } from "./task-graph-pg-state.js"
import { buildNativeChildPacketContent, buildNativeRootPacketContent, nativeVerificationRootPacketHistory } from "./native-verification-pg-evidence.js"
import {
  loadNativeVerificationOwnedState, nativeVerificationBindingDigest, nativeVerificationFrontier,
  nativeVerificationTarget, type NativeVerificationOwnedState,
} from "./native-verification-pg-bindings.js"
import { ensureNativeVerificationControl, nativeVerificationControlContentMatches, type NativeVerificationControlTask } from "./native-verification-pg-request.js"
import {
  nativeVerificationControlMatchesCurrentTarget, nativeVerificationHistory,
  nativeVerificationTypedCriteriaReady, readNativeVerificationControlProofs,
  readNativeVerificationFailedRootRejectionWithClient, type NativeVerificationControlProof,
} from "./native-verification-pg-readback.js"
import type {
  NativeVerificationEnsureResult, NativeVerificationFeedback, NativeVerificationPort,
  NativeVerificationRecoverableGoal, NativeVerificationRootGoalWitness,
} from "./native-verification-port.js"
import type { NativeVerificationTargetBinding } from "./native-verification-contract.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { PgSubagentPool } from "./types.js"

type Client = Pick<pg.PoolClient, "query">
type LockedState = Readonly<{ parent: Record<string, unknown>; graph: LoadedGraph; state: NativeVerificationOwnedState }>
const ACTIVE = new Set(["queued", "waiting", "running", "retrying", "waiting_for_user"])

const emptyResult = (status: NativeVerificationEnsureResult["status"]): NativeVerificationEnsureResult => ({
  status, controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [],
})

export function createPgNativeVerificationPort(pool: PgSubagentPool): NativeVerificationPort {
  return {
    async ensureChildren(scope) {
      try { return await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
        const locked = await lockAndLoad(client, scope, true)
        return ensureChildrenInClient(client, scope, locked)
      }) } catch (error) { if (isDataUnavailable(error)) return emptyResult("unavailable"); throw error }
    },
    async ensureRootGoal(input) {
      try { return await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
        const locked = await lockAndLoad(client, input.scope, true)
        if (!validCandidate(input.candidateText) || !rootStateReady(locked.state)) return emptyResult("unavailable")
        const children = await ensureChildrenInClient(client, input.scope, locked)
        if (children.status !== "passed") return children
        const graphReadiness = graphLeavesReadiness(locked.graph, locked.state)
        if (graphReadiness.pendingTaskIds.length) return combine(children, "pending", graphReadiness.pendingTaskIds)
        if (!graphReadiness.ready || !nativeVerificationTypedCriteriaReady(locked.graph)) return combine(children, "failed", [])

        const proofs = await readNativeVerificationControlProofs(client, input.scope)
        const history = nativeVerificationHistory(proofs)
        const candidateDigest = digestNativeVerificationValue(input.candidateText)
        const childBindingSetDigest = nativeVerificationBindingDigest(locked.state, history)
        const packetHistory = nativeVerificationRootPacketHistory(history, historyTargets(proofs), candidateDigest, childBindingSetDigest)
        const content = buildNativeRootPacketContent({ state: locked.state, candidateText: input.candidateText, childBindingSetDigest, history: packetHistory })
        if (!content) return combine(children, "unavailable", [])
        const target: NativeVerificationTargetBinding = { kind: "root_goal", candidateDigest, childBindingSetDigest }
        const control = await ensureNativeVerificationControl(client, { scope: input.scope, parent: locked.parent, target, content })
        if (!control) return combine(children, "unavailable", [])
        const allProofs = await readNativeVerificationControlProofs(client, input.scope)
        const rootProof = allProofs.find(item => item.task.taskId === control.taskId)
        if (!rootProof) return combine(children, "unavailable", [])
        return rootResult(children, rootProof)
      }) } catch (error) { if (isDataUnavailable(error)) return emptyResult("unavailable"); throw error }
    },
    async readRecoverableGoal(scope) {
      try { return await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
        const locked = await lockAndLoad(client, scope, false)
        if (!rootStateReady(locked.state) || !nativeVerificationTypedCriteriaReady(locked.graph)) return null
        const graphReadiness = graphLeavesReadiness(locked.graph, locked.state)
        if (!graphReadiness.ready) return null
        const proofs = await readNativeVerificationControlProofs(client, scope)
        const history = nativeVerificationHistory(proofs)
        const children = nativeVerificationFrontier(locked.state)
        if (children.some(node => !proofs.some(item => item.disposition === "passed"
          && nativeVerificationControlMatchesCurrentTarget(item, locked.state, node.key)))) return null
        const bindingDigest = nativeVerificationBindingDigest(locked.state, history)
        const root = [...proofs].reverse().find(item => item.task.control.target.kind === "root_goal")
        if (!root || root.task.control.target.kind !== "root_goal"
          || root.task.control.target.childBindingSetDigest !== bindingDigest) return null
        const target = root.task.packet.target
        if (target.kind !== "root_goal" || target.candidateDigest !== root.task.control.target.candidateDigest
          || digestNativeVerificationValue(target.candidateText) !== target.candidateDigest) return null
        const content = buildNativeRootPacketContent({ state: locked.state, candidateText: target.candidateText,
          childBindingSetDigest: bindingDigest, history: nativeVerificationRootPacketHistory(history, historyTargets(proofs), target.candidateDigest, bindingDigest) })
        if (!content || !nativeVerificationControlPacketMatches(root.task, content)) return null
        if (root.disposition === "pending") return { controlTaskId: root.task.taskId, candidateText: target.candidateText,
          status: "pending", feedback: null }
        if (root.disposition === "passed") {
          const witness = rootWitness(root)
          return witness ? { controlTaskId: root.task.taskId, candidateText: target.candidateText,
            status: "passed", feedback: null, witness } : null
        }
        return { controlTaskId: root.task.taskId, candidateText: null, status: root.disposition,
          feedback: feedbackFor(root) }
      }) } catch (error) { if (isDataUnavailable(error)) return null; throw error }
    },
    async readFailedRootSemanticRejection(input) {
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
        const locked = await lockAndLoad(client, input.scope, true)
        return readNativeVerificationFailedRootRejectionWithClient(client, { ...input, graph: locked.graph, state: locked.state })
      })
    },
  }
}

async function lockAndLoad(client: Client, scope: TaskGraphExecutionScope | TaskGraphReadScope, requireAdmission: boolean): Promise<LockedState> {
  if (scope.parentTaskId !== scope.rootTaskId) throw new Error("native_verification_root_scope_required")
  const parent = await lockTaskGraphScope(client, scope, requireAdmission)
  const graph = await loadTaskGraph(client, scope, true)
  const state = await loadNativeVerificationOwnedState(client, scope, graph.snapshot, true)
  return { parent, graph, state }
}

async function ensureChildrenInClient(client: Client, scope: TaskGraphExecutionScope, locked: LockedState): Promise<NativeVerificationEnsureResult> {
  const nodes = nativeVerificationFrontier(locked.state), controls: NativeVerificationControlTask[] = []
  const pendingTargets = new Set<string>(), failedTarget = { value: false }
  for (const node of nodes) {
    const task = locked.state.tasks.get(node.taskId)
    if (!task) return emptyResult("unavailable")
    const target = nativeVerificationTarget(locked.state, node)
    if (!target) {
      if (ACTIVE.has(task.status)) pendingTargets.add(task.id)
      else failedTarget.value = true
      continue
    }
    const content = await buildNativeChildPacketContent(client, locked.state, target)
    if (!content || !node.nativeDelegation) return emptyResult("unavailable")
    const binding: NativeVerificationTargetBinding = {
      kind: "child", nodeId: node.key, nativeOperationId: node.nativeDelegation.operationId,
      fingerprint: node.nativeDelegation.requestFingerprint, taskId: target.task.id,
      attempt: target.attempt, resultDigest: target.resultDigest,
    }
    const control = await ensureNativeVerificationControl(client, { scope, parent: locked.parent, target: binding, content })
    if (!control) return emptyResult("unavailable")
    controls.push(control)
  }
  const proofs = await readNativeVerificationControlProofs(client, scope), feedback: NativeVerificationFeedback[] = []
  const pendingControls = new Set<string>(), pendingTasks = new Set(pendingTargets)
  for (const control of controls) {
    const proof = proofs.find(item => item.task.taskId === control.taskId)
    if (!proof || !controlMatchesRequestedTarget(proof, control)) return emptyResult("unavailable")
    if (proof.disposition === "pending") { pendingControls.add(control.taskId); pendingTasks.add(control.taskId) }
    else if (proof.disposition !== "passed") feedback.push(feedbackFor(proof))
  }
  const resultStatus = failedTarget.value || feedback.some(item => item.disposition === "failed") ? "failed"
    : feedback.length ? "uncertain" : pendingTasks.size ? "pending" : "passed"
  return { status: resultStatus, controlTaskIds: controls.map(item => item.taskId),
    pendingControlTaskIds: [...pendingControls], pendingTaskIds: [...pendingTasks], feedback }
}

function controlMatchesRequestedTarget(proof: NativeVerificationControlProof, control: NativeVerificationControlTask): boolean {
  return proof.task.taskId === control.taskId && proof.task.control.controlOperationId === control.control.controlOperationId
    && proof.task.control.evidencePacketDigest === control.control.evidencePacketDigest
}

function feedbackFor(proof: NativeVerificationControlProof): NativeVerificationFeedback {
  return {
    controlTaskId: proof.task.taskId,
    targetTaskId: proof.task.control.target.kind === "child" ? proof.task.control.target.taskId : proof.task.control.owner.rootTaskId,
    disposition: proof.disposition === "failed" || proof.disposition === "uncertain" ? proof.disposition : "uncertain",
    criteria: proof.report?.criteria.map(item => ({ criterionId: item.criterionId, disposition: item.disposition,
      reasonCode: item.reasonCode, evidenceReferenceIds: item.evidenceReferenceIds })) ?? [],
  }
}

function rootResult(children: NativeVerificationEnsureResult, proof: NativeVerificationControlProof): NativeVerificationEnsureResult {
  const ids = [...new Set([...children.controlTaskIds, proof.task.taskId])]
  if (proof.disposition === "pending") return { ...children, status: "pending", controlTaskIds: ids,
    pendingControlTaskIds: [...new Set([...children.pendingControlTaskIds, proof.task.taskId])],
    pendingTaskIds: [...new Set([...children.pendingTaskIds, proof.task.taskId])] }
  if (proof.disposition !== "passed") return { ...children, status: proof.disposition, controlTaskIds: ids,
    feedback: [...children.feedback, feedbackFor(proof)] }
  const witness = rootWitness(proof)
  return witness ? { ...children, status: "passed", controlTaskIds: ids, rootGoalWitness: witness }
    : { ...children, status: "unavailable", controlTaskIds: ids }
}

function rootWitness(proof: NativeVerificationControlProof): NativeVerificationRootGoalWitness | null {
  const target = proof.task.control.target
  if (target.kind !== "root_goal" || proof.disposition !== "passed" || !proof.report || !proof.reportDigest
    || proof.task.status !== "completed" || proof.task.failureReason !== null) return null
  return { controlTaskId: proof.task.taskId, controlOperationId: proof.task.control.controlOperationId,
    currentControlAttempt: proof.task.attemptCount, candidateDigest: target.candidateDigest,
    childBindingSetDigest: target.childBindingSetDigest, goalDigest: proof.task.control.goalDigest,
    criteriaDigest: proof.task.control.criteriaDigest, evidencePacketDigest: proof.task.control.evidencePacketDigest,
    reportDigest: proof.reportDigest }
}

function historyTargets(proofs: readonly NativeVerificationControlProof[]) {
  return proofs.map(proof => ({ controlTaskId: proof.task.taskId, targetKind: proof.task.control.target.kind,
    ...(proof.task.control.target.kind === "root_goal" ? { candidateDigest: proof.task.control.target.candidateDigest,
      childBindingSetDigest: proof.task.control.target.childBindingSetDigest } : {}) }))
}

function nativeVerificationControlPacketMatches(task: NativeVerificationControlTask, content: NonNullable<ReturnType<typeof buildNativeRootPacketContent>>): boolean {
  return nativeVerificationControlContentMatches(task.packet, content)
}

function rootStateReady(state: NativeVerificationOwnedState): boolean {
  return state.criteriaValid && !state.turnGoalConflict && Boolean(state.goal) && state.nativeSourcesValid
}

function graphLeavesReadiness(graph: LoadedGraph, state: NativeVerificationOwnedState): Readonly<{ ready: boolean; pendingTaskIds: readonly string[] }> {
  const nodes = state.snapshot?.nodes ?? []
  const nativeKeys = new Set(nodes.filter(node => node.nativeDelegation).map(node => node.key))
  const frontier = nativeVerificationFrontier(state), activeNative = new Set(frontier.map(node => node.key))
  const superseded = new Set([...nativeKeys].filter(key => !activeNative.has(key)))
  const leaves = nodes.filter(node => !nodes.some(child => child.dependsOn.includes(node.key)) || activeNative.has(node.key))
  const repaired = new Set(graph.state?.repairSatisfiedNodeKeys ?? []), pending = new Set<string>()
  let ready = true
  for (const node of leaves) {
    if (superseded.has(node.key) || repaired.has(node.key)) continue
    const task = state.tasks.get(node.taskId)
    if (!task || task.status !== "completed" || task.failureReason !== null || task.result === null) {
      if (task && ACTIVE.has(task.status)) pending.add(task.id)
      else ready = false
    }
  }
  return { ready, pendingTaskIds: [...pending] }
}

function validCandidate(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 16 * 1024
}

function combine(children: NativeVerificationEnsureResult, status: NativeVerificationEnsureResult["status"], pending: readonly string[]): NativeVerificationEnsureResult {
  return { ...children, status, pendingTaskIds: [...new Set([...children.pendingTaskIds, ...pending])] }
}

function isDataUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (["task_graph_session_fenced", "task_graph_turn_fenced", "task_graph_parent_fenced", "task_graph_step_fenced",
    "task_graph_scope_invalid", "native_verification_session_fenced", "native_verification_root_scope_required"].includes(error.message)) return false
  return error.message.startsWith("native_verification_") || error.message.startsWith("task_graph_snapshot_")
    || error.message === "task_graph_verification_report_invalid" || error.message === "task_graph_task_scope_invalid"
}
