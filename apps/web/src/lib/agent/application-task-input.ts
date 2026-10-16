export type FormQuestion = { detail?: string; missing?: unknown[]; sensitive?: unknown[] };
export type FormQuestionField = { key: string | null; label: string };

const FORM_ANSWER_KEY_V2 = /^form-answer-v2-[a-f0-9]{64}$/;

export function formQuestionFields(value: unknown): FormQuestionField[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const question = value as FormQuestion;
  const missing = Array.isArray(question.missing) ? question.missing : [];
  const sensitive = Array.isArray(question.sensitive) ? question.sensitive : [];
  const seen = new Set<string>();
  return [...missing, ...sensitive].flatMap(raw => {
    const field = readField(raw);
    if (!field) return [];
    const identity = field.key ?? "legacy:" + field.label;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [field];
  }).slice(0, 10);
}

/** Only accept concise, user-entered values for fields the worker actually paused on. */
export function sanitizeConfirmedAnswers(question: unknown, value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const expected = new Set(formQuestionFields(question).flatMap(field => field.key ? [field.key] : []));
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (!expected.has(key) || typeof raw !== "string") return [];
    const answer = raw.trim();
    return answer && answer.length <= 500 ? [[key, answer] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function readField(raw: unknown): FormQuestionField | null {
  if (typeof raw === "string" && raw.trim()) return { key: raw, label: raw.trim().slice(0, 200) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const field = raw as { key?: unknown; label?: unknown };
  if (typeof field.label !== "string" || !field.label.trim()) return null;
  const key = typeof field.key === "string" && FORM_ANSWER_KEY_V2.test(field.key) ? field.key : null;
  return { key, label: field.label.trim().slice(0, 200) };
}
