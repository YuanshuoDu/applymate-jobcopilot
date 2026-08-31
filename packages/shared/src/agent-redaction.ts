import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|resume|cv|raw[_-]?(?:content|text|data)|content|value|question|answer|draft|sensitive|confirmed[_-]?answers|\bname\b)/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /\b(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_EMAIL = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi
const SENSITIVE_PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g
const SENSITIVE_ASSIGNMENT = /\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi
const EVENT_SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|nonce|email|phone|address|linkedin|github|(?:full[_-]?)?resume(?:[_-]?(?:text|content|data))?|cv(?:[_-]?(?:text|content|data))?|raw[_-]?(?:content|text|data)|content|value|question|answer|sensitive|confirmed[_-]?answers)/i

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_TOKEN, "Bearer [REDACTED]")
    .replace(SENSITIVE_KEY_TOKEN, "[REDACTED]")
    .replace(SENSITIVE_EMAIL, "[REDACTED_EMAIL]")
    .replace(SENSITIVE_PHONE, "[REDACTED_PHONE]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
}

export function redactSensitiveValue(value: unknown, key: string | null = null, depth = 0, maxDepth = 8): RepositoryJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, null, depth + 1, maxDepth))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactSensitiveValue(entryValue, entryKey, depth + 1, maxDepth),
  ]))
}

export function redactAgentEvent(input: { type: string; body: string; data?: unknown }): { body: string; data: RepositoryJsonValue | null } {
  return {
    body: redactSensitiveText(input.body),
    data: input.data === undefined ? null : redactEventValue(input.data),
  }
}

/**
 * Event payloads retain safe product structure such as automation drafts and
 * job titles, while still removing credentials, answer fields, raw resumes,
 * and direct contact data. Lifecycle/tool payloads use the stricter generic
 * redactor above because they are not rendered back into the user transcript.
 */
function redactEventValue(value: unknown, key: string | null = null, depth = 0, maxDepth = 8, insideResume = false): RepositoryJsonValue {
  const resumeContainer = insideResume || key === "resume" || key === "cv"
  if (key && EVENT_SENSITIVE_KEY.test(key) && key !== "resume" && key !== "cv") return "[REDACTED]"
  if (insideResume && key === "content") return "[REDACTED]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= maxDepth) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry, null, depth + 1, maxDepth, resumeContainer))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactEventValue(entryValue, entryKey, depth + 1, maxDepth, resumeContainer),
  ]))
}
