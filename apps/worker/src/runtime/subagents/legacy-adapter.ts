import { makeEvidence, validateRoleResult, type AnalystFinding, type AnalystResult, type RoleEvidence, type ScoutCandidate, type ScoutResult } from "./role-results.js"
import type { MigratedRole } from "./role-contracts.js"

export function adaptLegacyRoleResult(role: MigratedRole, value: unknown, source = "legacy-role-adapter"): ScoutResult | AnalystResult {
  if (isStructured(value)) return validateRoleResult(value, role)
  const row = asRecord(value)
  const evidence = parseLegacyEvidence(row.evidence, source)
  const result = role === "scout" ? adaptScout(row, evidence, source) : adaptAnalyst(row, evidence, source)
  return validateRoleResult(result, role)
}

function adaptScout(row: Record<string, unknown>, evidence: RoleEvidence[], source: string): ScoutResult {
  const candidates: ScoutCandidate[] = items(row, ["jobs", "candidates", "results"]).map((item, index) => {
    const jobId = required(item, ["jobId", "id"], `legacy scout item ${index}`)
    const itemSource = text(item, ["source", "provider", "ats"]) ?? source
    const itemEvidence = evidenceFor(item, evidence, jobId, index, "job", itemSource)
    return { jobId, source: itemSource, url: text(item, ["url", "applyUrl", "hostedUrl"]) ?? null, evidenceIds: itemEvidence }
  })
  return { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates, evidence, summary: text(row, ["summary", "message"]) ?? `Adapted ${candidates.length} scout candidates` }
}

function adaptAnalyst(row: Record<string, unknown>, evidence: RoleEvidence[], source: string): AnalystResult {
  const findings: AnalystFinding[] = items(row, ["findings", "analyses", "scores", "results"]).map((item, index) => {
    const jobId = required(item, ["jobId", "id"], `legacy analyst item ${index}`)
    const score = number(item, ["score", "matchScore"])
    const itemEvidence = evidenceFor(item, evidence, jobId, index, "job", source)
    return { jobId, score, evidenceIds: itemEvidence }
  })
  return { schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings, evidence, summary: text(row, ["summary", "message"]) ?? `Adapted ${findings.length} analyst findings` }
}

function evidenceFor(item: Record<string, unknown>, existing: RoleEvidence[], ref: string, index: number, kind: "job", source: string): string[] {
  const ids = Array.isArray(item.evidenceIds) ? item.evidenceIds.filter((id): id is string => typeof id === "string" && existing.some(evidence => evidence.id === id)) : []
  if (ids.length > 0) return [...new Set(ids)]
  const evidence = makeEvidence(`legacy:${kind}:${ref}:${index}`, kind, ref, source)
  existing.push(evidence)
  return [evidence.id]
}

function parseLegacyEvidence(value: unknown, source: string): RoleEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const row = asRecord(item)
    const id = text(row, ["id", "evidenceId"]) ?? `legacy:evidence:${index}`
    const ref = text(row, ["ref", "jobId", "sourceRef"])
    const kind = text(row, ["kind"]) as RoleEvidence["kind"] | null
    return ref && kind && ["job", "persona", "resume", "source"].includes(kind) ? [makeEvidence(id, kind, ref, text(row, ["source", "provider"]) ?? source)] : []
  })
}
function items(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown>[] { for (const key of keys) if (Array.isArray(row[key])) return row[key].filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)); return [] }
function asRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return value as Record<string, unknown> }
function text(row: Record<string, unknown>, keys: readonly string[]): string | null { for (const key of keys) if (typeof row[key] === "string" && row[key].trim()) return row[key] as string; return null }
function required(row: Record<string, unknown>, keys: readonly string[], label: string): string { const value = text(row, keys); if (!value) throw new Error(`${label} is missing a real id`); return value }
function number(row: Record<string, unknown>, keys: readonly string[]): number { for (const key of keys) if (typeof row[key] === "number") return row[key] as number; throw new Error("Legacy analyst item is missing a score") }
function isStructured(value: unknown): boolean { const row = asRecord(value); return row.schemaVersion === "agent-harness.v2.subagent.result" }
