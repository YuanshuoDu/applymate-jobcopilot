import { parsePersistedTaskGraphNode, validTaskGraphResultEnvelopeKeys } from "./plan-ledger-task-graph-metadata.js"
import { projectTaskEvidencePreview, type TaskGraphSnapshotNode } from "./plan-ledger.js"

type RawNode = Record<string, unknown>
type LineageInput = Readonly<{
  rawNode: RawNode
  node: TaskGraphSnapshotNode
  row: RawNode
  result: RawNode
  report: RawNode
  expected: readonly (RawNode | null)[]
  actual: readonly (RawNode | null)[]
  graphNodes: readonly (RawNode | null)[]
  taskIds: readonly string[]
  rows: ReadonlyMap<string, RawNode>
  rootTaskId: string
  digestCanonicalJson?: (canonicalJson: string) => string | null
}>

const VERIFIER_VERSION = "agent-harness.v2.task-graph-verifier.v1"
const RECEIPT_VERSION = "agent-harness.v2.task-graph-repair-receipt.v1"
const DIGEST = /^[a-f0-9]{64}$/
const REASONS = new Set(["criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid",
  "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved"])
const INVALID_CRITERION_REASONS = new Set(["criteria_met", "criterion_not_met", "reported_score_below_minimum", "repair_target_unresolved"])

/** Checks that recorded verification still matches the same owner-scoped graph rows. */
export function hasCurrentTaskGraphVerificationLineage(input: LineageInput): boolean {
  return validTaskGraphResultEnvelopeKeys(input.result) && validResultEnvelope(input.result)
    && coherentReport(input.report, input.expected, input.actual, input.row.status, input.result.status)
    && validDependencyBindings(input) && validRepairRelation(input)
}

function validDependencyBindings(input: LineageInput): boolean {
  return currentBindings(input.report, input.expected, input.node, input.graphNodes, input.taskIds, input.rows, input.digestCanonicalJson)
}

function currentBindings(reportValue: RawNode, expected: readonly (RawNode | null)[], node: TaskGraphSnapshotNode,
  graphNodes: readonly (RawNode | null)[], taskIds: readonly string[], rows: ReadonlyMap<string, RawNode>,
  digestCanonicalJson?: (canonicalJson: string) => string | null): boolean {
  const keys = expected.flatMap(item => {
    const check = item && record(item.check)
    return (check?.kind === "findings_from_scout_dependency" || check?.kind === "findings_cover_scout_candidates_gte")
      && typeof check.dependencyNodeKey === "string" ? [check.dependencyNodeKey] : []
  })
  const unique = [...new Set(keys)].sort()
  const requiresCurrentScout = expected.some(item => record(item?.check)?.kind === "findings_cover_scout_candidates_gte")
  if (unique.some(key => !node.dependsOn.includes(key))) return false
  const bindings = reportValue.dependencyBindings
  if (bindings === undefined) return !requiresCurrentScout && (reportValue.status !== "passed" || unique.length === 0)
  if (!Array.isArray(bindings) || bindings.length !== unique.length) return false
  return bindings.every((rawBinding, index) => {
    const key = unique[index], binding = record(rawBinding), rawDependency = graphNodes.find(candidate => candidate?.key === key)
    if (!key || !binding || !rawDependency) return false
    const dependency = parsePersistedTaskGraphNode(rawDependency), row = dependency && rows.get(dependency.taskId)
    const contract = record(rawDependency.verification), criteria = contract && criteriaOf(contract.criteria)
    const result = row && parseJsonRecord(row.result), report = result && record(result.taskGraphVerificationReport)
    const reportCriteria = report && criteriaOf(report.criteria)
    return Boolean(typeof binding.taskId === "string" && binding.nodeKey === key && dependency && dependency.templateId === "scout"
      && dependency.taskId === binding.taskId && taskIds.includes(binding.taskId)
      && row?.role === "scout" && row.status === "completed" && row.failureReason === null && row.attemptCount === binding.attemptCount
      && contract?.role === "scout" && criteria && result && report && reportCriteria && validTaskGraphResultEnvelopeKeys(result)
      && validResultEnvelope(result) && result.status === "completed" && projectTaskEvidencePreview(row) !== null
      && exact(report, "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion") && report.status === "passed"
      && report.resultDigest === binding.resultDigest && report.evidenceDigest === binding.evidenceDigest
      && digestEquals(binding.nodeDigest, currentScoutNode(rawDependency, dependency), digestCanonicalJson)
      && digestEquals(binding.reportDigest, currentReport(report, reportCriteria), digestCanonicalJson)
      && coherentReport(report, criteria, reportCriteria, row.status, result.status))
  })
}

function currentScoutNode(raw: RawNode, node: TaskGraphSnapshotNode): RawNode | null {
  if (node.templateId !== "scout" || raw.verificationDisposition !== "typed" || !Object.hasOwn(raw, "verification")) return null
  const normalized: RawNode = { key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: [...node.successCriteria],
    dependsOn: [...node.dependsOn], depth: Number(node.depth), taskId: node.taskId, verificationDisposition: "typed", verification: raw.verification }
  if (Object.hasOwn(raw, "repairOf")) normalized.repairOf = raw.repairOf
  if (Object.hasOwn(raw, "registeredScoutEnvelope")) normalized.registeredScoutEnvelope = raw.registeredScoutEnvelope
  try { return canonicalTaskGraphJson(normalized) === canonicalTaskGraphJson(raw) ? normalized : null } catch { return null }
}

function currentReport(report: RawNode, criteria: readonly (RawNode | null)[]): RawNode | null {
  if (criteria.some(item => !item)) return null
  return { verifierVersion: report.verifierVersion, status: report.status, reasonCode: report.reasonCode,
    criteria: criteria.map(item => ({ criterionId: item!.criterionId, status: item!.status, reasonCode: item!.reasonCode })),
    evidenceDigest: report.evidenceDigest, resultDigest: report.resultDigest }
}

function digestEquals(expected: unknown, value: RawNode | null, digestCanonicalJson?: (canonicalJson: string) => string | null): boolean {
  if (!value || typeof digestCanonicalJson !== "function") return false
  try {
    const digest = digestCanonicalJson(canonicalTaskGraphJson(value))
    return typeof digest === "string" && DIGEST.test(digest) && digest === expected
  } catch { return false }
}

/** Mirrors Worker canonicalTaskGraphJson, including its parsing of JSON-looking strings. */
function canonicalTaskGraphJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskGraphJson).join(",")}]`
  const row = jsonObject(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskGraphJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("task_graph_json_invalid")
  return encoded
}

function jsonObject(value: unknown): RawNode | null {
  let parsed = value
  if (typeof value === "string") { try { parsed = JSON.parse(value) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0 ? parsed as RawNode : null
  } catch { return null }
}

function validRepairRelation(input: LineageInput): boolean {
  const repair = Object.hasOwn(input.rawNode, "repairOf"), hasReceipt = Object.hasOwn(input.result, "taskGraphRepairReceipt")
  if (!repair) return !hasReceipt && input.report.reasonCode !== "repair_target_unresolved"
  const relation = record(input.rawNode.repairOf), contract = record(input.rawNode.verification)
  const relationIds = relation?.criterionIds
  if (!relation || !contract || !exact(relation, "criterionIds,graphRootTaskId,nodeKey,taskId")
    || relation.graphRootTaskId !== input.rootTaskId || relation.nodeKey === input.node.key || !id(relation.nodeKey) || !id(relation.taskId)
    || !Array.isArray(relationIds) || relationIds.length < 1 || relationIds.length > 8) return false
  const currentIndex = input.graphNodes.findIndex(candidate => candidate?.key === input.node.key)
  const targetIndex = input.graphNodes.findIndex(candidate => candidate?.key === relation.nodeKey)
  const rawTarget = targetIndex >= 0 ? input.graphNodes[targetIndex] : null
  const target = rawTarget && parsePersistedTaskGraphNode(rawTarget), targetContract = rawTarget && record(rawTarget.verification)
  const targetRow = target && input.rows.get(target.taskId), targetCriteria = targetContract && criteriaOf(targetContract.criteria)
  const repairCriteria = criteriaOf(contract.criteria)
  const targetResult = targetRow && parseJsonRecord(targetRow.result), targetReport = targetResult && record(targetResult.taskGraphVerificationReport)
  const targetReportCriteria = targetReport && criteriaOf(targetReport.criteria)
  if (!target || !rawTarget || currentIndex < 1 || targetIndex >= currentIndex
    || target.taskId !== relation.taskId || target.templateId !== input.node.templateId || !targetContract || !targetCriteria || !repairCriteria || !targetRow
    || targetContract.role !== contract.role || targetRow?.role !== targetContract.role || targetRow.status !== "failed"
    || !targetResult || !targetReport || !targetReportCriteria || !validTaskGraphResultEnvelopeKeys(targetResult) || !validResultEnvelope(targetResult)
    || !["failed", "unverified"].includes(String(targetReport.status)) || targetRow.failureReason !== `task_graph_verification_${targetReport.status}`
    || !coherentReport(targetReport, targetCriteria, targetReportCriteria, targetRow.status, targetResult.status)
    || !currentBindings(targetReport, targetCriteria, target, input.graphNodes, input.taskIds, input.rows, input.digestCanonicalJson)) return false
  if (new Set(relationIds).size !== relationIds.length || repairCriteria.length !== relationIds.length
    || !relationIds.every(id => typeof id === "string" && targetCriteria.some(item => item?.id === id
      && targetReportCriteria.some((reported, index) => targetCriteria[index]?.id === id && (reported?.status === "failed" || reported?.status === "unverified"))))
    || !repairCriteria.every(item => Boolean(item && relationIds.includes(item.id)
      && sameCheck(item.check, targetCriteria.find(targetItem => targetItem?.id === item.id)?.check)))) return false
  if ((input.report.status === "passed") !== hasReceipt) return false
  return !hasReceipt || validReceipt(input.result.taskGraphRepairReceipt, relation, input.report, input.node, input.rootTaskId)
}

function validReceipt(value: unknown, relation: RawNode, report: RawNode, node: TaskGraphSnapshotNode, rootTaskId: string): boolean {
  const receipt = record(value), relationIds = relation.criterionIds, receiptIds = receipt?.criterionIds
  return Boolean(receipt && report.status === "passed" && exact(receipt,
    "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    && Array.isArray(relationIds) && Array.isArray(receiptIds) && receipt.schemaVersion === RECEIPT_VERSION
    && receipt.verifierVersion === VERIFIER_VERSION && receipt.graphRootTaskId === rootTaskId
    && receipt.targetNodeKey === relation.nodeKey && receipt.targetTaskId === relation.taskId
    && receipt.repairNodeKey === node.key && receipt.repairTaskId === node.taskId
    && receipt.evidenceDigest === report.evidenceDigest && receiptIds.length === relationIds.length
    && receiptIds.every((id, index) => id === relationIds[index]))
}


function coherentReport(report: RawNode, expected: readonly (RawNode | null)[], actual: readonly (RawNode | null)[], taskStatus: unknown, resultStatus: unknown): boolean {
  if (!exact(report, "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    && !exact(report, "criteria,dependencyBindings,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")) return false
  if (report.verifierVersion !== VERIFIER_VERSION || typeof report.reasonCode !== "string" || !REASONS.has(report.reasonCode)
    || !["passed", "failed", "unverified"].includes(String(report.status)) || actual.length !== expected.length || expected.length < 1
    || actual.some((item, index) => !item || item.criterionId !== expected[index]?.id || !REASONS.has(String(item.reasonCode))
      || !["passed", "failed", "unverified"].includes(String(item.status)))) return false
  if (actual.some(item => item!.status === "passed" && item!.reasonCode !== "criteria_met"
    || item!.status === "failed" && !["criterion_not_met", "reported_score_below_minimum"].includes(String(item!.reasonCode))
    || item!.status === "unverified" && INVALID_CRITERION_REASONS.has(String(item!.reasonCode)))) return false
  const failed = actual.find(item => item!.status === "failed")
  const unresolved = report.status === "unverified" && report.reasonCode === "repair_target_unresolved" && report.evidenceDigest === null
    && digest(report.resultDigest) && actual.every(item => item!.status === "passed" && item!.reasonCode === "criteria_met")
  let coherent = unresolved
  if (!coherent && report.status === "passed") coherent = report.reasonCode === "criteria_met" && digest(report.evidenceDigest)
    && digest(report.resultDigest) && actual.every(item => item!.status === "passed")
  if (!coherent && report.status === "failed") coherent = digest(report.evidenceDigest) && digest(report.resultDigest) && Boolean(failed)
    && report.reasonCode === failed!.reasonCode && actual.every(item => item!.status !== "unverified")
  if (!coherent && report.status === "unverified") coherent = report.evidenceDigest === null
    ? report.resultDigest === null && actual.every(item => item!.status === "unverified" && item!.reasonCode === report.reasonCode)
    : digest(report.evidenceDigest) && digest(report.resultDigest) && actual.every(item => item!.status === "unverified" && item!.reasonCode === report.reasonCode)
  return coherent && (report.status === "passed" ? taskStatus === "completed" && resultStatus === "completed"
    : taskStatus === "failed" && (resultStatus === "completed" || resultStatus === "failed"))
}

function validResultEnvelope(result: RawNode): boolean {
  return (result.status === "completed" || result.status === "failed") && integer(result.stepCount, 10_000)
    && integer(result.toolCallCount, 10_000) && typeof result.finalText === "string" && result.finalText.length <= 8_192
    && (result.finalItemId === null || id(result.finalItemId))
}
function criteriaOf(value: unknown): Array<RawNode | null> | null { return Array.isArray(value) ? value.map(record) : null }
function sameCheck(left: unknown, right: unknown): boolean {
  const a = record(left), b = record(right)
  return Boolean(a && b && exact(a, Reflect.ownKeys(b).filter((key): key is string => typeof key === "string").sort().join(","))
    && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]))
}
function parseJsonRecord(value: unknown): RawNode | null {
  try { return record(typeof value === "string" ? JSON.parse(value) as unknown : value) } catch { return null }
}
function record(value: unknown): RawNode | null {
  try { return value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).every(key => typeof key === "string") ? value as RawNode : null } catch { return null }
}
function exact(value: RawNode, keys: string): boolean { return Reflect.ownKeys(value).sort().join(",") === keys }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }
function integer(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max }
function digest(value: unknown): boolean { return typeof value === "string" && DIGEST.test(value) }
