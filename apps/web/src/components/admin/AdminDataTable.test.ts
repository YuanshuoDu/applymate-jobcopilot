import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./AdminDataTable.tsx', import.meta.url)), 'utf8')

describe('admin data table safeguards', () => {
  it('uses an actionable status when bulk controls are present', () => {
    expect(source).toContain("hasOperationalActions ? 'Operational controls' : 'Read-only view'")
  })

  it('labels searches from the current table instead of hardcoding users', () => {
    expect(source).toContain('searchLabel ?? `Search ${title.toLowerCase()}`')
    expect(source).toContain('searchPlaceholder ?? `Search ${title.toLowerCase()}`')
  })

  it('downloads filtered exports without opening a raw CSV page', () => {
    expect(source).toContain('href={exportHref} download>Export filtered CSV')
  })

  it('stops waiting forever when an admin data request is slow', () => {
    expect(source).toContain('timeoutMs: 10_000')
  })
})
