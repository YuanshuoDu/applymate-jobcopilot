export function nextRunAtFromCron(cron: string | null, now = new Date(), timezone = "UTC"): Date | null {
  if (!cron) return null
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minute = exactNumber(parts[0], 0, 59)
  const hour = exactNumber(parts[1], 0, 23)
  if (minute == null || hour == null) return null

  const allowedDays = daySet(parts[4])
  if (!allowedDays) return null
  const zone = validTimeZone(timezone) ? timezone : "UTC"
  const start = localParts(now, zone)

  for (let offset = 0; offset <= 8; offset += 1) {
    const localDate = addUtcDays(start.year, start.month, start.day, offset)
    const cronDay = localDate.weekday === 0 ? 7 : localDate.weekday
    const candidate = zonedTimeToUtc(localDate.year, localDate.month, localDate.day, hour, minute, zone)
    if (allowedDays.has(cronDay) && candidate.getTime() > now.getTime()) return candidate
  }
  return null
}

export function nextRunAfterCurrent(cron: string | null, current = new Date(), timezone = "UTC"): Date | null {
  return nextRunAtFromCron(cron, new Date(current.getTime() + 60_000), timezone)
}

function exactNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  return number >= min && number <= max ? number : null
}

function daySet(value: string): Set<number> | null {
  if (value === '*') return new Set([1, 2, 3, 4, 5, 6, 7])
  const range = value.match(/^([1-7])-([1-7])$/)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (start > end) return null
    return new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index))
  }
  if (/^[1-7]$/.test(value)) return new Set([Number(value)])
  return null
}

function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  return {
    year: Number(parts.find(part => part.type === "year")?.value),
    month: Number(parts.find(part => part.type === "month")?.value),
    day: Number(parts.find(part => part.type === "day")?.value),
  }
}

function addUtcDays(year: number, month: number, day: number, offset: number) {
  const date = new Date(Date.UTC(year, month - 1, day + offset))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  }
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = timezoneOffsetMs(new Date(utcMs), timezone)
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset
  }
  return new Date(utcMs)
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - date.getTime()
}
