const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8,
  sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
}

const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?'

export function extractInterviewSchedule(text: string, referenceDate: Date): Date | null {
  const normalized = text.replace(/\s+/g, ' ')
  const relative = normalized.match(new RegExp(`\\b(tomorrow)\\b(?:\\s*(?:at|@|,|-)?\\s*${TIME})`, 'i'))
  if (relative) return buildRelative(referenceDate, relative)

  const dayFirst = normalized.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]{3,9})(?:\\s*,?\\s*(\\d{4}))?\\s*(?:at|@|,|-)?\\s*${TIME}\\b`, 'i'))
  if (dayFirst) return buildDate(dayFirst[3], dayFirst[2], dayFirst[1], dayFirst[4], dayFirst[5], dayFirst[6], referenceDate)

  const monthFirst = normalized.match(new RegExp(`\\b([a-z]{3,9})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\s*(?:at|@|,|-)?\\s*${TIME}\\b`, 'i'))
  if (monthFirst) return buildDate(monthFirst[3], monthFirst[1], monthFirst[2], monthFirst[4], monthFirst[5], monthFirst[6], referenceDate)

  const iso = normalized.match(new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})[T\\s]+${TIME}\\b`, 'i'))
  if (iso) return buildDate(iso[1], String(Number(iso[2])), iso[3], iso[4], iso[5], iso[6], referenceDate)
  return null
}

function buildRelative(referenceDate: Date, match: RegExpMatchArray) {
  const date = new Date(referenceDate)
  date.setDate(date.getDate() + 1)
  return setTime(date, match[2], match[3], match[4])
}

function buildDate(yearValue: string | undefined, monthValue: string, dayValue: string, hour: string, minute: string | undefined, meridiem: string | undefined, referenceDate: Date) {
  const month = /^\d+$/.test(monthValue) ? Number(monthValue) - 1 : MONTHS[monthValue.toLowerCase()]
  if (month === undefined || !isDay(dayValue)) return null
  const year = yearValue ? Number(yearValue) : inferredYear(referenceDate, month, Number(dayValue))
  const date = new Date(year, month, Number(dayValue))
  return date.getMonth() === month && date.getDate() === Number(dayValue) ? setTime(date, hour, minute, meridiem) : null
}

function setTime(date: Date, hourValue: string, minuteValue: string | undefined, meridiem: string | undefined) {
  let hour = Number(hourValue)
  const minute = minuteValue ? Number(minuteValue) : 0
  if (hour > 23 || minute > 59 || (!meridiem && hour > 23)) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0)
  }
  date.setHours(hour, minute, 0, 0)
  return date
}

function isDay(value: string) {
  const day = Number(value)
  return day >= 1 && day <= 31
}

function inferredYear(referenceDate: Date, month: number, day: number) {
  const candidate = new Date(referenceDate.getFullYear(), month, day)
  return candidate.getTime() < referenceDate.getTime() - 86_400_000 ? referenceDate.getFullYear() + 1 : referenceDate.getFullYear()
}
