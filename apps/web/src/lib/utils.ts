import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Decode common HTML entities in text from job APIs */
export function decodeEntities(text: string): string {
  if (!text) return ''
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate text to max length, decoding HTML entities and appending "…" if truncated */
export function truncate(text: string, max = 2000): string {
  const clean = decodeEntities(text)
  if (!clean || clean.length <= max) return clean
  return clean.slice(0, max).trimEnd() + '…'
}

const CURRENCY_MAP: Record<string, string> = {
  '£': '£', '$': '$', '€': '€', 'C$': 'C$',
  gb: '£', us: '$', ca: 'C$', au: 'A$',
  gbp: '£', usd: '$', eur: '€',
  de: '€', fr: '€', nl: '€', at: '€', be: '€', es: '€', it: '€', pl: '€',
}

/**
 * Format salary range for display.
 * `region` can be a 2-letter country code (gb→£, us→$) or a currency-like string (GBP→£, EUR→€, USD→$).
 */
export function fmtSalary(
  min?: number | null,
  max?: number | null,
  region = '€',
): string | undefined {
  if (!min && !max) return undefined
  const sym   = CURRENCY_MAP[region.toLowerCase()] ?? '€'
  const scale = (n: number) => n >= 10000 ? `${sym}${Math.round(n / 1000)}k` : `${sym}${n}`
  if (min && max) return `${scale(min)} – ${scale(max)}`
  if (min)        return `${scale(min)}+`
  return `up to ${scale(max!)}`
}
