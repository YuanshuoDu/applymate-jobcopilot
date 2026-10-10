export type SchedulerTaskState = {
  lastSuccessfulAt: number | null
  consecutiveFailures: number
  nextAttemptAt: number
  lastFailure: string | null
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
const SHORT_WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ")
const LONG_WEEKDAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ")

type HttpDateParts = {
  weekday: string
  day: string
  month: string
  year: string
  hour: string
  minute: string
  second: string
  longWeekday?: boolean
  twoDigitYear?: boolean
}

const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/

export function createSchedulerTaskState(): SchedulerTaskState {
  return { lastSuccessfulAt: null, consecutiveFailures: 0, nextAttemptAt: 0, lastFailure: null }
}

export function getSchedulerTaskState(states: Map<string, SchedulerTaskState>, name: string): SchedulerTaskState {
  const existing = states.get(name)
  if (existing) return existing
  const created = createSchedulerTaskState()
  states.set(name, created)
  return created
}

export function markSchedulerTaskFailure(
  state: SchedulerTaskState,
  failure: string,
  now: number,
  taskIntervalMs: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
  retryAfterAt?: number,
): void {
  state.consecutiveFailures += 1
  const baseDelay = Math.max(taskIntervalMs, retryBaseDelayMs)
  const maxDelay = Math.max(baseDelay, retryMaxDelayMs)
  const exponent = Math.min(state.consecutiveFailures - 1, 30)
  const exponentialDelay = Math.min(maxDelay, baseDelay * 2 ** exponent)
  const boundedHint = typeof retryAfterAt === "number" && Number.isFinite(retryAfterAt)
    ? Math.min(Math.max(0, retryAfterAt - now), Math.max(0, retryMaxDelayMs))
    : 0
  state.nextAttemptAt = now + Math.min(maxDelay, Math.max(exponentialDelay, boundedHint))
  state.lastFailure = failure
}

export function parseRetryAfterAt(value: string | null, observedAt: number, maxDelayMs: number): number | undefined {
  if (value === null || !value.trim() || !Number.isFinite(observedAt) || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) return undefined
  const maximumRetryAt = observedAt + maxDelayMs
  if (!Number.isFinite(maximumRetryAt)) return undefined
  const normalized = value.trim()
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized)
    if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000) return maximumRetryAt
    return Math.min(observedAt + seconds * 1_000, maximumRetryAt)
  }
  const retryAt = parseHttpDate(normalized, observedAt)
  if (retryAt === undefined) return undefined
  return Math.min(retryAt, maximumRetryAt)
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE.exec(value)
  const rfc850 = RFC850_DATE.exec(value)
  const asctime = ASCTIME_DATE.exec(value)
  if (!imf && !rfc850 && !asctime) return undefined

  let parts: HttpDateParts
  if (imf) {
    parts = { weekday: imf[1], day: imf[2], month: imf[3], year: imf[4], hour: imf[5], minute: imf[6], second: imf[7] }
  } else if (rfc850) {
    parts = { weekday: rfc850[1], day: rfc850[2], month: rfc850[3], year: rfc850[4], hour: rfc850[5], minute: rfc850[6], second: rfc850[7], longWeekday: true, twoDigitYear: true }
  } else if (asctime) {
    parts = { weekday: asctime[1], month: asctime[2], day: asctime[3].trim(), hour: asctime[4], minute: asctime[5], second: asctime[6], year: asctime[7] }
  } else {
    return undefined
  }

  const month = MONTHS.indexOf(parts.month)
  const second = Number(parts.second)
  if (second > 60) return undefined
  let year = Number(parts.year)
  const weekdayNames = parts.longWeekday ? LONG_WEEKDAYS : SHORT_WEEKDAYS
  if (parts.twoDigitYear) {
    const currentYear = new Date(now).getUTCFullYear()
    if (!Number.isFinite(currentYear)) return undefined
    year += Math.floor(currentYear / 100) * 100
  }

  const makeDate = (targetYear: number) => {
    const date = new Date(0)
    date.setUTCFullYear(targetYear, month, Number(parts.day))
    date.setUTCHours(Number(parts.hour), Number(parts.minute), Math.min(second, 59), 0)
    return date
  }
  let date = makeDate(year)
  if (parts.twoDigitYear) {
    const fiftyYearsAhead = new Date(now)
    fiftyYearsAhead.setUTCFullYear(fiftyYearsAhead.getUTCFullYear() + 50)
    if (date.getTime() + (second === 60 ? 1_000 : 0) > fiftyYearsAhead.getTime()) date = makeDate(year - 100)
    year = date.getUTCFullYear()
  }
  const retryAt = date.getTime() + (second === 60 ? 1_000 : 0)
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month ||
    date.getUTCDate() !== Number(parts.day) || date.getUTCHours() !== Number(parts.hour) ||
    date.getUTCMinutes() !== Number(parts.minute) || date.getUTCSeconds() !== Math.min(second, 59) ||
    date.getUTCDay() !== weekdayNames.indexOf(parts.weekday) || retryAt < now
  ) return undefined
  return retryAt
}

export function markSchedulerTaskSuccess(state: SchedulerTaskState, now: number): void {
  state.lastSuccessfulAt = now
  state.consecutiveFailures = 0
  state.nextAttemptAt = 0
  state.lastFailure = null
}
