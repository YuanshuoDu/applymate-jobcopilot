const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|password|secret|client[_-]?secret|private[_-]?key|bearer)$/i
const BEARER_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const API_KEY_VALUE = /\b(?:sk|key|token)-[A-Za-z0-9._-]{12,}\b/gi
const JSON_SECRET_VALUE = /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)"\s*:\s*")[^"]+/gi

/** Redact credentials that may have been captured in agent logs or state. */
export function sanitizeExportValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(JSON_SECRET_VALUE, '$1[REDACTED]')
      .replace(BEARER_VALUE, '$1[REDACTED]')
      .replace(API_KEY_VALUE, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(item => sanitizeExportValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeExportValue(entryValue, entryKey),
    ]))
  }
  return value
}
