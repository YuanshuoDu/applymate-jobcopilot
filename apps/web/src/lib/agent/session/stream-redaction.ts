import { redactSensitiveText, redactSensitiveValue } from '@jobcopilot/shared'

export function redactStreamString(value: string): string {
  return redactSensitiveText(value)
}

export function redactStreamValue(value: unknown, key: string | null = null, depth = 0): unknown {
  return redactSensitiveValue(value, key, depth, 6)
}
