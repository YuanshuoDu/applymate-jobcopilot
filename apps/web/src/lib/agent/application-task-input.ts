export type FormQuestion = { detail?: string; missing?: string[]; sensitive?: string[] }

export function formQuestionFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const question = value as FormQuestion
  return [...(question.missing ?? []), ...(question.sensitive ?? [])]
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 10)
}

/** Only accept concise, user-entered values for fields the worker actually paused on. */
export function sanitizeConfirmedAnswers(question: unknown, value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const expected = new Set(formQuestionFields(question))
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (!expected.has(key) || typeof raw !== "string") return []
    const answer = raw.trim()
    return answer && answer.length <= 500 ? [[key, answer] as const] : []
  })
  return entries.length ? Object.fromEntries(entries) : null
}
