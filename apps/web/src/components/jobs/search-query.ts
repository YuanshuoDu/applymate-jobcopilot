export interface DetectedSearchFilters {
  location?: string
  remote?: boolean
  jobType?: string
  datePosted?: string
  experience?: string
}

const CITY_HINTS: Record<string, string> = {
  dublin: 'Dublin', cork: 'Cork', galway: 'Galway', limerick: 'Limerick',
  amsterdam: 'Amsterdam', rotterdam: 'Rotterdam', eindhoven: 'Eindhoven', utrecht: 'Utrecht',
  berlin: 'Berlin', munich: 'Munich', münchen: 'Munich', hamburg: 'Hamburg', frankfurt: 'Frankfurt',
  vienna: 'Vienna', wien: 'Vienna', zurich: 'Zurich', zürich: 'Zurich',
  london: 'London', manchester: 'Manchester', edinburgh: 'Edinburgh', birmingham: 'Birmingham',
  paris: 'Paris', lyon: 'Lyon', brussels: 'Brussels', madrid: 'Madrid', barcelona: 'Barcelona',
  rome: 'Rome', milan: 'Milan', warsaw: 'Warsaw', stockholm: 'Stockholm', copenhagen: 'Copenhagen',
  oslo: 'Oslo', helsinki: 'Helsinki', lisbon: 'Lisbon', porto: 'Porto', prague: 'Prague', budapest: 'Budapest',
}

function removeTerm(query: string, term: string) {
  return query.replace(new RegExp(`(?:^|[\\s,])${term}(?=$|[\\s,])`, 'i'), ' ')
}

export function extractSearchQuery(query: string): { cleanQ: string; filters: DetectedSearchFilters } {
  let cleanQ = query.trim()
  const filters: DetectedSearchFilters = {}

  for (const [hint, city] of Object.entries(CITY_HINTS)) {
    const match = new RegExp(`(?:^|\\s|,)${hint}(?:\\s|,|$)`, 'i')
    if (match.test(cleanQ)) {
      filters.location = city
      cleanQ = removeTerm(cleanQ, hint)
      break
    }
  }

  if (/\b(remote|wfh|work from home|anywhere|worldwide)\b/i.test(cleanQ)) {
    filters.remote = true
    cleanQ = cleanQ.replace(/\b(remote|wfh|work from home|anywhere|worldwide)\b/gi, ' ')
  }
  if (/\b(intern|internship|placement)\b/i.test(cleanQ)) filters.jobType = 'internship'
  else if (/\b(contract|freelance|contractor)\b/i.test(cleanQ)) filters.jobType = 'contract'
  if (/\b(junior|jr\.?|entry|graduate|fresher)\b/i.test(cleanQ)) filters.experience = 'entry'
  else if (/\b(senior|sr\.?|staff|principal)\b/i.test(cleanQ)) filters.experience = 'senior'
  else if (/\b(lead|manager|head of|director)\b/i.test(cleanQ)) filters.experience = 'lead'
  else if (/\b(mid|intermediate)\b/i.test(cleanQ)) filters.experience = 'mid'
  if (/\b(today|24h|last 24 hours)\b/i.test(cleanQ)) filters.datePosted = 'today'
  else if (/\b(this week|last week|7 days)\b/i.test(cleanQ)) filters.datePosted = 'week'
  else if (/\b(this month|last month|30 days)\b/i.test(cleanQ)) filters.datePosted = 'month'

  return { cleanQ: cleanQ.replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim() || query.trim(), filters }
}
