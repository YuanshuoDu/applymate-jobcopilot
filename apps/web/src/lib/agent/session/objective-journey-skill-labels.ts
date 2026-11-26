const MAX_LABELS = 32
const MAX_CANDIDATE_LABELS = 128
const MAX_LABEL_LENGTH = 96
const MAX_SOURCE_LENGTH = 2_048

export type ObjectiveJourneySkillLabel = Readonly<{ label: string; normalizedLabel: string }>

/** Parses the only supported confirmed Persona Skills field without exposing its value. */
export function parseConfirmedPastedSkills(value: unknown, expectedNormalizedValue: unknown): readonly string[] | undefined {
  if (typeof value !== "string" || typeof expectedNormalizedValue !== "string" || value.length > MAX_SOURCE_LENGTH
    || value.trim().toLowerCase() !== expectedNormalizedValue || !value.trim()) return undefined
  return parseLabels(value)
}

/** Keeps Job.keywords advisory: a label survives only after one whole literal hit in verified quotes. */
export function matchObjectiveJourneySkillLabels(keywords: unknown, quotes: readonly unknown[]): readonly ObjectiveJourneySkillLabel[] {
  const labels = typeof keywords === "string" ? parseCandidateLabels(keywords) : undefined
  if (!labels || !Array.isArray(quotes) || quotes.length > 8 || quotes.some(quote => typeof quote !== "string")) return []
  const boundedQuotes = quotes as readonly string[]
  return labels.filter(label => countWholeLiteralOccurrences(label, boundedQuotes) === 1)
    .map(label => ({ label, normalizedLabel: normalizeObjectiveJourneySkillLabel(label) }))
}

export function normalizeObjectiveJourneySkillLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}

/** Keeps both the persisted source and the owner-facing DTO within skill-label grammar. */
export function isObjectiveJourneySkillLabel(value: unknown): value is string {
  return typeof value === "string" && validLabel(value)
}

function parseLabels(value: string): readonly string[] | undefined {
  if (value.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const parts = value.split(",").map(item => item.trim())
  if (parts.length === 0 || parts.length > MAX_LABELS || parts.some(item => !validLabel(item))) return undefined
  const normalized = parts.map(normalizeObjectiveJourneySkillLabel)
  return new Set(normalized).size === normalized.length ? parts : undefined
}

function parseCandidateLabels(value: string): readonly string[] | undefined {
  if (value.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const labels = value.split(",").map(item => item.trim()).filter(validLabel)
  if (labels.length === 0) return []
  const seen = new Set<string>()
  return labels.filter(label => {
    const normalized = normalizeObjectiveJourneySkillLabel(label)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).slice(0, MAX_CANDIDATE_LABELS)
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= MAX_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)
    && /[\p{L}\p{N}]/u.test(value) && /^[\p{L}\p{N} .+#/&_-]+$/u.test(value)
    && !/\b(?:https?|ftp|www|must|required|responsible|experience|experienced|years?|proficient|familiar|ability|knowledge|including|using)\b/i.test(value)
    && !value.includes("://") && !value.includes("@") && value.split(/\s+/u).length <= 4
    && !/[!?.,]$/u.test(value) && (!value.includes(".") || /^(?:\.[\p{L}\p{N}_-]+|.+\.(?:js|jsx|tsx?|net|sql|py|rb|go))$/iu.test(value))
}

function countWholeLiteralOccurrences(label: string, quotes: readonly string[]): number {
  let count = 0
  const needle = label.toLowerCase()
  for (const quote of quotes) {
    const haystack = quote.toLowerCase()
    let offset = haystack.indexOf(needle)
    while (offset >= 0) {
      if (wholeOccurrence(haystack, offset, needle.length, needle)) count++
      if (count > 1) return count
      offset = haystack.indexOf(needle, offset + Math.max(1, needle.length))
    }
  }
  return count
}

function wholeOccurrence(value: string, offset: number, length: number, needle: string): boolean {
  const before = offset === 0 ? "" : value[offset - 1]!
  const after = offset + length >= value.length ? "" : value[offset + length]!
  const beforeBefore = offset < 2 ? "" : value[offset - 2]!
  const afterAfter = offset + length + 1 >= value.length ? "" : value[offset + length + 1]!
  const beforeBeforeBefore = offset < 3 ? "" : value[offset - 3]!
  const afterAfterAfter = offset + length + 2 >= value.length ? "" : value[offset + length + 2]!
  if (needle.length === 1 && /[\p{L}\p{M}\p{N}]/u.test(needle)
    && (/[/]/u.test(after) && (/[+#]/u.test(afterAfter) || wordCharacter(afterAfter) && /[+#]/u.test(afterAfterAfter))
      || /[/]/u.test(before) && (/[+#]/u.test(beforeBefore) || wordCharacter(beforeBefore) && /[+#]/u.test(beforeBeforeBefore)))) return false
  if (!needle.startsWith(".") && before === ".") return false
  if (!needle.endsWith(".") && after === "." && wordCharacter(afterAfter)) return false
  return !wordCharacter(before) && !wordCharacter(after)
}

function wordCharacter(value: string): boolean { return value.length > 0 && /[\p{L}\p{M}\p{N}_+#]/u.test(value) }
