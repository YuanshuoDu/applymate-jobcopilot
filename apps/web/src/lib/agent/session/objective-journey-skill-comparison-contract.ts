import { isObjectiveJourneySkillLabel, normalizeObjectiveJourneySkillLabel } from "./objective-journey-skill-labels"

export const OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA = "agent-harness.v2.objective-skill-comparison.v1" as const
export const OBJECTIVE_JOURNEY_SKILL_MAX = 32 as const
export const OBJECTIVE_JOURNEY_SUGGESTED_TERMS_MAX = 8 as const

const COVERAGE = ["unavailable", "partial", "complete"] as const
const EVIDENCE_STATUS = ["confirmed_persona_match", "needs_confirmation"] as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MAX_SKILLS = OBJECTIVE_JOURNEY_SKILL_MAX
const MAX_SLOTS = 8
const MAX_SUGGESTED_TERMS = OBJECTIVE_JOURNEY_SUGGESTED_TERMS_MAX
const MAX_LABEL_LENGTH = 96

export type ObjectiveJourneySkillEvidenceStatus = typeof EVIDENCE_STATUS[number]
export type ObjectiveJourneySkillComparison = Readonly<{
  schemaVersion: typeof OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA
  finalItemId: string
  graphRevision: number
  coverage: typeof COVERAGE[number]
  skills: readonly Readonly<{ label: string; evidenceStatus: ObjectiveJourneySkillEvidenceStatus; slotOrdinals: readonly number[] }>[]
  suggestedTerms: readonly string[]
}>
type ObjectiveJourneySkill = ObjectiveJourneySkillComparison["skills"][number]

/** Accepts only the quote-free, owner-facing comparison projection. */
export function parseObjectiveJourneySkillComparison(value: unknown): ObjectiveJourneySkillComparison | undefined {
  const row = record(value), skills = row && dense(row.skills, MAX_SKILLS), suggested = row && dense(row.suggestedTerms, MAX_SUGGESTED_TERMS)
  if (!row || !exact(row, "coverage,finalItemId,graphRevision,schemaVersion,skills,suggestedTerms")
    || row.schemaVersion !== OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA || !id(row.finalItemId)
    || !positive(row.graphRevision) || !oneOf(row.coverage, COVERAGE) || !skills || !suggested) return undefined
  const parsed = skills.map(parseSkill)
  if (parsed.some(skill => !skill)) return undefined
  const normalized = parsed.map(skill => normalize(skill!.label))
  if (new Set(normalized).size !== normalized.length || !sortedSkills(parsed as NonNullable<typeof parsed[number]>[])) return undefined
  const terms = suggested.map(value => typeof value === "string" && validText(value, MAX_LABEL_LENGTH) ? value : undefined)
  if (terms.some(term => !term) || new Set(terms.map(term => normalize(term!))).size !== terms.length
    || terms.some(term => {
      const skill = parsed.find(item => item!.label === term)
      return !skill || skill.evidenceStatus !== "confirmed_persona_match"
    })) return undefined
  if (row.coverage === "unavailable" && (parsed.length > 0 || terms.length > 0)) return undefined
  return { schemaVersion: OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA, finalItemId: row.finalItemId, graphRevision: row.graphRevision,
    coverage: row.coverage, skills: parsed as ObjectiveJourneySkillComparison["skills"], suggestedTerms: terms as string[] }
}

function parseSkill(value: unknown): ObjectiveJourneySkillComparison["skills"][number] | undefined {
  const row = record(value), slots = row && dense(row.slotOrdinals, MAX_SLOTS)
  if (!row || !exact(row, "evidenceStatus,label,slotOrdinals") || !isObjectiveJourneySkillLabel(row.label)
    || !validText(row.label, MAX_LABEL_LENGTH)
    || !oneOf(row.evidenceStatus, EVIDENCE_STATUS) || !slots || slots.length === 0) return undefined
  const ordinals = slots.map(value => positive(value) ? value : undefined)
  if (ordinals.some(value => value === undefined) || new Set(ordinals).size !== ordinals.length
    || ordinals.some((value, index) => index > 0 && value! <= ordinals[index - 1]!)) return undefined
  return { label: row.label, evidenceStatus: row.evidenceStatus, slotOrdinals: ordinals as number[] }
}

function sortedSkills(skills: readonly ObjectiveJourneySkillComparison["skills"][number][]): boolean {
  return skills.every((skill, index) => index === 0 || compareObjectiveJourneySkillRows(skills[index - 1]!, skill) < 0)
}

/** Shared code-point ordering for service ranking and DTO validation. */
export function compareObjectiveJourneySkillRows(left: ObjectiveJourneySkill, right: ObjectiveJourneySkill): number {
  return right.slotOrdinals.length - left.slotOrdinals.length
    || (left.evidenceStatus < right.evidenceStatus ? -1 : left.evidenceStatus > right.evidenceStatus ? 1 : 0)
    || (normalize(left.label) < normalize(right.label) ? -1 : normalize(left.label) > normalize(right.label) ? 1 : 0)
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}
function exact(row: Record<string, unknown>, csv: string): boolean {
  const expected = csv.split(","), keys = Reflect.ownKeys(row)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}
function dense(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  return Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value)
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T { return typeof value === "string" && choices.includes(value as T) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}
function normalize(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
