const SAFE_ACCENT = /^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|var\(--primary\))$/i

export function safeAccentColor(value: unknown, fallback = '#185FA5'): string {
  return typeof value === 'string' && SAFE_ACCENT.test(value.trim()) ? value.trim() : fallback
}

export function safeTemplateOptions(value: unknown): { accentColor: string; fontFamily: 'serif' | 'sans' | 'mono'; density: 'compact' | 'comfortable' | 'spacious' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const fontFamily = input.fontFamily === 'serif' || input.fontFamily === 'mono' ? input.fontFamily : 'sans'
  const density = input.density === 'compact' || input.density === 'spacious' ? input.density : 'comfortable'
  // Old resumes may contain a free-form color from before validation existed.
  // Normalize it to the product token so editing and saving those resumes does
  // not turn a security migration into a user-visible save failure.
  return { accentColor: safeAccentColor(input.accentColor, 'var(--primary)'), fontFamily, density }
}
