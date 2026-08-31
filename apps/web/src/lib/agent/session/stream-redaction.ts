const SENSITIVE_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|(?:full[_-]?)?resume(?:[_-]?(text|content|data))?|cv(?:[_-]?(text|content|data))?|raw[_-]?(content|text))/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /\b(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi

export function redactStreamString(value: string): string {
  return value.replace(SENSITIVE_TOKEN, "Bearer [REDACTED]").replace(SENSITIVE_KEY_TOKEN, "[REDACTED]")
}

export function redactStreamValue(value: unknown, key: string | null = null, depth = 0): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactStreamString(value)
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (depth >= 6) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redactStreamValue(entry, null, depth + 1))
  if (typeof value !== "object") return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactStreamValue(entryValue, entryKey, depth + 1)]))
}
