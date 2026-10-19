import { Buffer } from "node:buffer"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import {
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  validateTaskGraphVerificationContract,
} from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"

export type TaskGraphStructuredOutputFailureCategory =
  | "missing_final_output"
  | "result_too_large"
  | "result_shape_invalid"
  | "evidence_binding_invalid"

const CATEGORIES = new Set<TaskGraphStructuredOutputFailureCategory>([
  "missing_final_output", "result_too_large", "result_shape_invalid", "evidence_binding_invalid",
])
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/
const PROJECTED_KEYS = "native,nativeResult,repairOf,repairReceipt,status,templateId,verification,verificationReport"
const PRIVATE_METADATA_KEYS = ["repairOf", "repairReceipt", "native", "nativeResult"] as const

type DataRecord = Record<string, unknown>

function dataRecord(value: unknown): DataRecord | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const output: DataRecord = Object.create(null) as DataRecord
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      output[key] = descriptor.value
    }
    return output
  } catch {
    return undefined
  }
}

/** Checks the raw failure marker without invoking getters or accepting inherited fields. */
export function hasTaskGraphVerificationUnverifiedFailureReason(value: unknown): boolean {
  return dataRecord(value)?.failureReason === "task_graph_verification_unverified"
}

function exactKeys(value: DataRecord, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected
}

function dataArray(value: unknown, minimum: number, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    const length = lengthDescriptor?.value
    if (!Number.isSafeInteger(length) || Number(length) < minimum || Number(length) > maximum || keys.length !== Number(length) + 1) return undefined
    const output: unknown[] = []
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch {
    return undefined
  }
}

/** Returns only the closed category after the current failed node and report agree. */
export function classifyTaskGraphStructuredOutputFailure(
  value: unknown,
): TaskGraphStructuredOutputFailureCategory | undefined {
  const input = dataRecord(value)
  if (!input || !exactKeys(input, "hasRepairReceipt,snapshotNode,task,verificationReport")
    || typeof input.hasRepairReceipt !== "boolean" || input.hasRepairReceipt) return undefined

  const node = dataRecord(input.snapshotNode)
  const task = dataRecord(input.task)
  const report = dataRecord(input.verificationReport)
  if (!node || !task || !report || Object.hasOwn(node, "repairOf") || Object.hasOwn(node, "nativeDelegation")
    || Object.hasOwn(node, "native") || Object.hasOwn(node, "nativeResult")) return undefined

  const role = node.templateId
  if ((role !== "scout" && role !== "analyst") || task.role !== role || task.id !== node.taskId
    || node.verificationDisposition !== "typed" || task.status !== "failed"
    || task.failureReason !== "task_graph_verification_unverified") return undefined

  const schema = dataRecord(task.expectedOutputSchema)
  if (!schema || !exactKeys(schema, "role,schemaVersion")
    || schema.schemaVersion !== ROLE_RESULT_SCHEMA || schema.role !== role) return undefined

  const verification = dataRecord(node.verification)
  if (!verification || !exactKeys(verification, "criteria,role,schemaVersion")
    || verification.schemaVersion !== TASK_GRAPH_VERIFICATION_SCHEMA_VERSION || verification.role !== role) return undefined
  const contractCriteria = dataArray(verification.criteria, 1, 8)
  if (!contractCriteria) return undefined
  const criterionIds: string[] = []
  for (const item of contractCriteria) {
    const criterion = dataRecord(item)
    if (!criterion || !exactKeys(criterion, "check,id") || typeof criterion.id !== "string" || !CRITERION_ID.test(criterion.id)) return undefined
    criterionIds.push(criterion.id)
  }
  if (new Set(criterionIds).size !== criterionIds.length) return undefined

  if (!exactKeys(report, "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || report.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION || report.status !== "unverified"
    || report.reasonCode !== "result_invalid" || report.evidenceDigest !== null || report.resultDigest !== null) return undefined
  const reportCriteria = dataArray(report.criteria, 1, 8)
  if (!reportCriteria || reportCriteria.length !== criterionIds.length) return undefined
  for (let index = 0; index < reportCriteria.length; index += 1) {
    const item = dataRecord(reportCriteria[index])
    if (!item || !exactKeys(item, "criterionId,reasonCode,status") || item.criterionId !== criterionIds[index]
      || item.status !== "unverified" || item.reasonCode !== "result_invalid") return undefined
  }

  const result = dataRecord(task.result)
  if (!result || result.status !== "failed" || Object.hasOwn(result, "taskGraphRepairReceipt")
    || Object.hasOwn(result, "native") || Object.hasOwn(result, "nativeResult")
    || Object.hasOwn(result, "nativeDelegation") || Object.hasOwn(result, "taskGraphNativeResultReceipt")) return undefined
  const category = result.structuredOutputFailureCategory
  return typeof category === "string" && CATEGORIES.has(category as TaskGraphStructuredOutputFailureCategory)
    ? category as TaskGraphStructuredOutputFailureCategory
    : undefined
}

/** Revalidates only the already parsed, model-visible current node metadata. */
export function projectTaskGraphStructuredFailureCategory(
  rawNode: unknown,
  parsed: unknown,
): TaskGraphStructuredOutputFailureCategory | undefined {
  const source = dataRecord(rawNode), view = dataRecord(parsed)
  if (!source || !view || !hasAllowedKeys(view, PROJECTED_KEYS, "status,templateId,verification,verificationReport")
    || PRIVATE_METADATA_KEYS.some(key => Object.hasOwn(view, key))) return undefined

  const role = view.templateId
  if (view.status !== "failed" || (role !== "scout" && role !== "analyst")
    || source.status !== view.status || source.templateId !== role) return undefined
  const category = source.structuredOutputFailureCategory
  if (typeof category !== "string" || !CATEGORIES.has(category as TaskGraphStructuredOutputFailureCategory)) return undefined

  const validation = validateTaskGraphVerificationContract(view.verification, role)
  if (!validation.ok) return undefined
  const report = dataRecord(view.verificationReport)
  if (!report || !exactKeys(report, "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || report.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION || report.status !== "unverified"
    || report.reasonCode !== "result_invalid" || report.evidenceDigest !== null || report.resultDigest !== null) return undefined
  const criteria = dataArray(report.criteria, 1, 8)
  const contractCriteria = validation.contract.criteria
  if (!criteria || criteria.length !== contractCriteria.length) return undefined
  for (let index = 0; index < criteria.length; index += 1) {
    const criterion = dataRecord(criteria[index])
    if (!criterion || !exactKeys(criterion, "criterionId,reasonCode,status")
      || criterion.criterionId !== contractCriteria[index]?.id
      || criterion.status !== "unverified" || criterion.reasonCode !== "result_invalid") return undefined
  }
  return category as TaskGraphStructuredOutputFailureCategory
}

/** Counts only the exact safe field added to the bounded current-verification projection. */
export function taskGraphStructuredFailureCategoryBytes(value: unknown): number {
  if (typeof value !== "string" || !CATEGORIES.has(value as TaskGraphStructuredOutputFailureCategory)) return 0
  return Buffer.byteLength(JSON.stringify({ structuredOutputFailureCategory: value }), "utf8")
}

function hasAllowedKeys(value: DataRecord, allowed: string, required: string): boolean {
  const keys = Object.keys(value).sort()
  const allowedKeys = allowed.split(",")
  const requiredKeys = required.split(",")
  return keys.every(key => allowedKeys.includes(key)) && requiredKeys.every(key => Object.hasOwn(value, key))
}
