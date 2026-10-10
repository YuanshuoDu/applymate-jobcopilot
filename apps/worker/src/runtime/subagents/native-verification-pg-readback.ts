import type pg from "pg"
import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"
import {
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationDisposition, type NativeVerificationReport,
} from "./native-verification-contract.js"
import { parseNativeVerificationReport } from "./native-verification-report.js"
import { nativeVerificationControlContentMatches, readNativeVerificationControlTasks, type NativeVerificationControlTask } from "./native-verification-pg-request.js"
import { buildNativeChildPacketContent, buildNativeRootPacketContent, nativeVerificationRootPacketHistory, type NativeVerificationHistoryEntry } from "./native-verification-pg-evidence.js"
import {
  loadNativeVerificationOwnedState, nativeVerificationBindingDigest, nativeVerificationFrontier,
  nativeVerificationTarget, type NativeVerificationOwnedState,
} from "./native-verification-pg-bindings.js"
import { currentTaskGraph, loadTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import type { NativeSemanticRejectionIdentity } from "../turns/native-semantic-rejection-ledger.js"
import type { NativeVerificationRootGoalWitness, NativeVerificationTerminalProofReader } from "./native-verification-port.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Queryable = Pick<pg.PoolClient, "query">
export type NativeVerificationControlProof = Readonly<{
  task: NativeVerificationControlTask
  report: NativeVerificationReport | null
  reportDigest: string | null
  disposition: NativeVerificationDisposition | "pending"
}>

/** Reads the private identity only when the failed root proof still matches current owned evidence. */
export async function readNativeVerificationFailedRootRejectionWithClient(client: Queryable, input: Readonly<{
  scope: TaskGraphReadScope
  graph: LoadedGraph
  state: NativeVerificationOwnedState
  candidateText: string
  controlTaskId: string
}>): Promise<NativeSemanticRejectionIdentity | null> {
  const { scope, graph, state, candidateText, controlTaskId } = input
  if (scope.parentTaskId !== scope.rootTaskId || !candidateText.trim() || Buffer.byteLength(candidateText, "utf8") > 16 * 1024
    || !state.criteriaValid || state.turnGoalConflict || !state.goal || !state.nativeSourcesValid || !nativeVerificationTypedCriteriaReady(graph)) return null
  const proofs = await readNativeVerificationControlProofs(client, scope)
  if (!await currentNativeChildrenMatch(client, graph, state, proofs)) return null
  const history = nativeVerificationHistory(proofs), candidateDigest = digestNativeVerificationValue(candidateText)
  const childBindingSetDigest = nativeVerificationBindingDigest(state, history)
  const matches = proofs.filter(item => item.task.taskId === controlTaskId)
  if (matches.length !== 1) return null
  const proof = matches[0]!, target = proof.task.control.target
  if (target.kind !== "root_goal" || target.candidateDigest !== candidateDigest || target.childBindingSetDigest !== childBindingSetDigest
    || proof.disposition !== "failed" || proof.report?.disposition !== "failed" || !proof.report.criteria.some(item => item.disposition === "failed")
    || proof.task.status !== "completed" || proof.task.failureReason !== null || !proof.reportDigest || proof.task.attemptCount < 1) return null
  const content = buildNativeRootPacketContent({ state, candidateText, childBindingSetDigest,
    history: nativeVerificationRootPacketHistory(history, historyTargets(proofs), candidateDigest, childBindingSetDigest) })
  if (!content || !nativeVerificationControlContentMatches(proof.task.packet, content)) return null
  return { candidateDigest, controlTaskId: proof.task.taskId, controlOperationId: proof.task.control.controlOperationId,
    controlAttempt: proof.task.attemptCount, controlReportDigest: proof.reportDigest }
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

/** Reads only reports rederived from a current persisted attempt, marker and packet. */
export async function readNativeVerificationControlProofs(
  client: Queryable, scope: TaskGraphReadScope,
): Promise<readonly NativeVerificationControlProof[]> {
  const controls = await readNativeVerificationControlTasks(client, scope)
  return controls.map(task => {
    const result = record(task.result), raw = result?.nativeVerificationReport
    const parsed = raw === undefined ? null : parseNativeVerificationReport(raw, task.control, task.packet, task.attemptCount)
    const report = task.status === "completed" && task.failureReason === null ? parsed : null
    let reportDigest: string | null = null
    try { if (report) reportDigest = digestNativeVerificationValue(report) } catch { /* invalid persisted proof remains non-passing */ }
    const active = ["queued", "waiting", "running", "retrying", "waiting_for_user"].includes(task.status)
    const disposition = active ? "pending" : task.status === "completed" && task.failureReason === null && report
      ? report.disposition : "uncertain"
    return { task, report, reportDigest, disposition }
  })
}

function historyTargets(proofs: readonly NativeVerificationControlProof[]) {
  return proofs.map(proof => ({ controlTaskId: proof.task.taskId, targetKind: proof.task.control.target.kind,
    ...(proof.task.control.target.kind === "root_goal" ? { candidateDigest: proof.task.control.target.candidateDigest,
      childBindingSetDigest: proof.task.control.target.childBindingSetDigest } : {}) }))
}

function currentGraphReady(graph: LoadedGraph, state: NativeVerificationOwnedState): boolean {
  const nodes = state.snapshot?.nodes ?? [], frontier = nativeVerificationFrontier(state)
  const native = new Set(nodes.filter(node => node.nativeDelegation).map(node => node.key)), active = new Set(frontier.map(node => node.key))
  const superseded = new Set([...native].filter(key => !active.has(key)))
  const repaired = new Set(graph.state?.repairSatisfiedNodeKeys ?? [])
  return nodes.filter(node => !nodes.some(child => child.dependsOn.includes(node.key)) || active.has(node.key)).every(node => {
    if (superseded.has(node.key) || repaired.has(node.key)) return true
    const task = state.tasks.get(node.taskId)
    return task?.status === "completed" && task.failureReason === null && task.result !== null
  })
}

async function currentNativeChildrenMatch(client: Queryable, graph: LoadedGraph, state: NativeVerificationOwnedState,
  proofs: readonly NativeVerificationControlProof[]): Promise<boolean> {
  if (!currentGraphReady(graph, state)) return false
  for (const node of nativeVerificationFrontier(state)) {
    const target = nativeVerificationTarget(state, node)
    const proof = proofs.find(item => item.disposition === "passed" && nativeVerificationControlMatchesCurrentTarget(item, state, node.key))
    if (!target || !proof) return false
    const content = await buildNativeChildPacketContent(client, state, target)
    if (!content || !nativeVerificationControlContentMatches(proof.task.packet, content)) return false
  }
  return true
}

export function nativeVerificationHistory(proofs: readonly NativeVerificationControlProof[]): readonly NativeVerificationHistoryEntry[] {
  return proofs.map(proof => {
    const target = proof.task.control.target
    const criterionSummary = JSON.stringify({
      failureReason: proof.task.failureReason === null ? null : safeFailure(proof.task.failureReason),
      criteria: proof.report?.criteria ?? null,
    })
    return {
      controlTaskId: proof.task.taskId,
      targetTaskId: target.kind === "child" ? target.taskId : proof.task.control.owner.rootTaskId,
      targetKind: target.kind === "child" ? "child" : "root_goal",
      ...(target.kind === "root_goal" ? { candidateDigest: target.candidateDigest, childBindingSetDigest: target.childBindingSetDigest } : {}),
      disposition: proof.report?.disposition ?? "uncertain",
      status: proof.task.status,
      attempt: proof.task.attemptCount,
      reportDigest: proof.reportDigest,
      criterionSummary,
    }
  })
}

function safeFailure(value: string): string {
  const safe = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  if (Buffer.byteLength(safe, "utf8") > 4_000) throw new Error("native_verification_failure_history_oversize")
  return safe
}

export function nativeVerificationControlMatchesCurrentTarget(proof: NativeVerificationControlProof, state: NativeVerificationOwnedState, nodeKey: string): boolean {
  const target = proof.task.control.target, node = state.snapshot?.nodes.find(item => item.key === nodeKey)
  if (!node?.nativeDelegation || target.kind !== "child" || target.nodeId !== node.key
    || target.nativeOperationId !== node.nativeDelegation.operationId || target.fingerprint !== node.nativeDelegation.requestFingerprint
    || target.taskId !== node.taskId) return false
  const current = nativeVerificationTarget(state, node)
  const packetTarget = proof.task.packet.target
  return Boolean(current && packetTarget.kind === "child" && proof.task.taskId === proof.task.control.controlTaskId
    && target.attempt === current.attempt && target.resultDigest === current.resultDigest
    && packetTarget.taskId === current.task.id && packetTarget.attempt === current.attempt
    && packetTarget.resultDigest === current.resultDigest && packetTarget.resultText === current.resultText
    && proof.task.packet.goal === current.goal
    && canonicalNativeVerificationJson(proof.task.packet.criteria.map(item => item.requirement)) === canonicalNativeVerificationJson(current.criteria))
}

export function nativeVerificationTypedCriteriaReady(loaded: Awaited<ReturnType<typeof loadTaskGraph>>): boolean {
  try {
    const current = currentTaskGraph(loaded)
    for (const node of loaded.snapshot?.nodes ?? []) {
      if (node.verificationDisposition !== "typed") continue
      const view = current.nodes.find(item => item.key === node.key)
      const repaired = loaded.state?.repairSatisfiedNodeKeys?.includes(node.key) === true
      if (!view || !repaired && (view.status !== "completed" || view.verificationReport?.status !== "passed")) return false
      if (node.repairOf && view.status === "completed" && view.verificationReport?.status === "passed" && !view.repairReceipt) return false
    }
    return true
  } catch { return false }
}

function witnessFor(proof: NativeVerificationControlProof): NativeVerificationRootGoalWitness | null {
  const target = proof.task.control.target, report = proof.report
  if (target.kind !== "root_goal" || proof.disposition !== "passed" || !report || !proof.reportDigest) return null
  return {
    controlTaskId: proof.task.taskId, controlOperationId: proof.task.control.controlOperationId,
    currentControlAttempt: proof.task.attemptCount, candidateDigest: target.candidateDigest,
    childBindingSetDigest: target.childBindingSetDigest, goalDigest: proof.task.control.goalDigest,
    criteriaDigest: proof.task.control.criteriaDigest, evidencePacketDigest: proof.task.control.evidencePacketDigest,
    reportDigest: proof.reportDigest,
  }
}

function sameWitness(left: NativeVerificationRootGoalWitness, right: NativeVerificationRootGoalWitness): boolean {
  return canonicalNativeVerificationJson(left) === canonicalNativeVerificationJson(right)
}

/** Terminal proof reader: uses the caller's client and rechecks the candidate and all owned bindings. */
export const readNativeVerificationTerminalProofWithClient: NativeVerificationTerminalProofReader = async (client, input) => {
  const { scope, candidateText, witness } = input
  if (scope.parentTaskId !== scope.rootTaskId || typeof candidateText !== "string" || candidateText.trim().length === 0
    || Buffer.byteLength(candidateText, "utf8") > 16 * 1024) return false
  let candidateDigest: string
  try { candidateDigest = digestNativeVerificationValue(candidateText) } catch { return false }
  if (candidateDigest !== witness.candidateDigest) return false

  const loaded = await loadTaskGraph(client, scope, true)
  const state = await loadNativeVerificationOwnedState(client, scope, loaded.snapshot, true)
  if (!nativeVerificationTypedCriteriaReady(loaded) || !state.criteriaValid || !state.goal || state.turnGoalConflict) return false
  const proofs = await readNativeVerificationControlProofs(client, scope)
  const children = nativeVerificationFrontier(state)
  for (const node of children) {
    const currentTarget = nativeVerificationTarget(state, node)
    const proof = proofs.find(item => item.disposition === "passed" && nativeVerificationControlMatchesCurrentTarget(item, state, node.key))
    if (!currentTarget || !proof) return false
    const currentContent = await buildNativeChildPacketContent(client, state, currentTarget)
    if (!currentContent || !nativeVerificationControlContentMatches(proof.task.packet, currentContent)) return false
  }
  const history = nativeVerificationHistory(proofs)
  const childBindingSetDigest = nativeVerificationBindingDigest(state, history)
  const proof = proofs.find(item => item.task.taskId === witness.controlTaskId)
  const expectedWitness = proof ? witnessFor(proof) : null
  if (!proof || !expectedWitness || !sameWitness(witness, expectedWitness)
    || proof.task.control.controlOperationId !== witness.controlOperationId
    || proof.task.control.target.kind !== "root_goal"
    || proof.task.control.target.childBindingSetDigest !== childBindingSetDigest
    || proof.task.control.target.candidateDigest !== candidateDigest) return false
  const rootHistory = nativeVerificationRootPacketHistory(history, proofs.map(item => ({
    controlTaskId: item.task.taskId, targetKind: item.task.control.target.kind,
    ...(item.task.control.target.kind === "root_goal" ? { candidateDigest: item.task.control.target.candidateDigest,
      childBindingSetDigest: item.task.control.target.childBindingSetDigest } : {}),
  })), candidateDigest, childBindingSetDigest)
  const content = buildNativeRootPacketContent({ state, candidateText, childBindingSetDigest, history: rootHistory })
  if (!content) return false
  return nativeVerificationControlContentMatches(proof.task.packet, content)
}
