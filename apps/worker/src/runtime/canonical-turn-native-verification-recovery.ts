import { Buffer } from "node:buffer"
import type { NativeVerificationPort, NativeVerificationRecoverableGoal } from "./subagents/native-verification-port.js"
import type { TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { nativeVerificationFeedbackText, parseNativeVerificationFeedback, parseNativeVerificationWitness } from "./canonical-turn-native-verification.js"

export type NativeVerificationRecovery = Readonly<{ candidateText?: string; feedback?: string }>
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.getOwnPropertyNames(value).length === Object.keys(value).length
    && Object.values(descriptors).every(item => item.enumerable && "value" in item) ? value as Record<string, unknown> : null
}
function exact(row: Record<string, unknown>, keys: string): boolean { return Object.keys(row).sort().join(",") === keys }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }

function parse(value: unknown): NativeVerificationRecoverableGoal | undefined {
  const row = record(value)
  if (!row || !id(row.controlTaskId) || !["pending", "passed", "failed", "uncertain"].includes(String(row.status))) return undefined
  const reports = row.feedback === null ? null : parseNativeVerificationFeedback([row.feedback])
  if (row.feedback !== null && !reports) return undefined
  if (row.status === "pending" || row.status === "passed") {
    const keys = row.status === "passed" ? "candidateText,controlTaskId,feedback,status,witness" : "candidateText,controlTaskId,feedback,status"
    if (!exact(row, keys) || typeof row.candidateText !== "string" || !row.candidateText.trim()
      || Buffer.byteLength(row.candidateText, "utf8") > 16 * 1024) return undefined
    if (row.status === "passed" && !parseNativeVerificationWitness(row.witness, row.candidateText)) return undefined
    return { controlTaskId: row.controlTaskId, status: row.status, candidateText: row.candidateText, feedback: reports?.[0] ?? null }
  }
  if (!exact(row, "candidateText,controlTaskId,feedback,status") || row.candidateText !== null) return undefined
  return { controlTaskId: row.controlTaskId, status: row.status as "failed" | "uncertain", candidateText: null, feedback: reports?.[0] ?? null }
}

/** Restores only the producer's validated current root candidate or safe status feedback. */
export async function readNativeVerificationRecovery(input: Readonly<{
  port: NativeVerificationPort
  scope: TaskGraphReadScope
}>): Promise<NativeVerificationRecovery> {
  const raw = await input.port.readRecoverableGoal(input.scope)
  if (raw === null) return {}
  const saved = parse(raw)
  if (!saved) throw new Error("native_verification_recovery_invalid")
  if (saved.candidateText !== null && saved.candidateText !== undefined) return { candidateText: saved.candidateText }
  return { feedback: nativeVerificationFeedbackText(saved.status, saved.feedback ? [saved.feedback] : []) }
}
