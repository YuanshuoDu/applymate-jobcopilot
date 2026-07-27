/** Normalize human-entered email addresses before using them as account keys. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}
