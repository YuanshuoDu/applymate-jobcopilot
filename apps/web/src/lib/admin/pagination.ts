export function adminPageLimit(value: string | null) {
  const parsed = Number(value ?? '25')
  if (!Number.isInteger(parsed)) return 25
  return Math.min(Math.max(parsed, 1), 100)
}

export function pageResult<T extends { id: string | number }>(rows: T[], limit: number) {
  const page = rows.slice(0, limit)
  return {
    items: page,
    nextCursor: rows.length > limit ? String(page[page.length - 1]?.id ?? '') : null,
  }
}
