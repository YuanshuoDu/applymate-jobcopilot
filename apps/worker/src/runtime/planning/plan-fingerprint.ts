import { createHash } from "node:crypto"

import { PLAN_MAX_REVISIONS, isPlainJsonObject, type PlanProposal } from "./goal-plan-contract.js"

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Plan fingerprint requires finite JSON numbers")
    return JSON.stringify(value)
  }
  if (typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && !isPlainJsonObject(value))) throw new TypeError("Plan fingerprint requires plain JSON")
  seen.add(value)
  const result = Array.isArray(value)
    ? `[${value.map(item => stableJson(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`
  seen.delete(value)
  return result
}

/** Returns a stable semantic hash; plan CAS metadata is intentionally excluded. */
export function fingerprintPlanProposal(proposal: PlanProposal): string {
  const { basedOnPlanRevision: _ignored, ...semantic } = proposal
  return `sha256:${createHash("sha256").update(stableJson(semantic), "utf8").digest("hex")}`
}

export function isPlanFingerprint(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value)
}

export function copyPlanFingerprints(values: readonly string[] | undefined): readonly string[] {
  const source = values ?? []
  if (!Array.isArray(source) || source.length > PLAN_MAX_REVISIONS) throw new TypeError(`Plan fingerprints must contain at most ${PLAN_MAX_REVISIONS} entries`)
  const result = [...source]
  if (result.some(value => !isPlanFingerprint(value)) || new Set(result).size !== result.length) throw new TypeError("Invalid or duplicate plan fingerprint")
  return Object.freeze(result)
}
