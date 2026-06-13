/**
 * Location Resolver — Intelligent location expansion for job search
 *
 * Converts user input like "Ireland" or "Dublin" into:
 *   - countryCode:  'ie'
 *   - searchTerms:  ['Ireland', 'Dublin'] (for API queries)
 *   - dbTerms:      ['ireland', 'dublin', 'cork', 'galway', ...] (for DB ILIKE filter)
 *   - canonical:    'Dublin, Ireland' (display name)
 *
 * Design: location filter is PRIMARY. Keywords (roles) are secondary/fuzzy.
 * When user sets "Ireland", ALL Irish cities match — not just literal "Ireland".
 */

export interface ResolvedLocation {
  input:       string       // original user input
  canonical:   string       // display name: "Dublin, Ireland"
  countryCode: string | null // 'ie', 'de', etc. null if not recognized
  isCountry:   boolean      // true if input is a country, false if city
  isRemote:    boolean
  // For API search (concise, high-signal terms)
  searchTerms: string[]
  // For DB ILIKE filter (all variations to match against)
  dbTerms:     string[]
}

// ── Country → cities map ──────────────────────────────────────────────────────

const COUNTRY_CITIES: Record<string, string[]> = {
  ie: ['Dublin', 'Cork', 'Galway', 'Limerick', 'Waterford', 'Drogheda', 'Dundalk',
       'Kilkenny', 'Sligo', 'Wexford', 'Athlone', 'Naas', 'Ennis', 'Bray',
       'Swords', 'Malahide', 'Greystones', 'Sandyford', 'Leopardstown',
       'Grand Canal', 'Docklands'],
  gb: ['London', 'Manchester', 'Edinburgh', 'Birmingham', 'Leeds', 'Glasgow',
       'Bristol', 'Liverpool', 'Sheffield', 'Cardiff', 'Belfast', 'Newcastle'],
  de: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart',
       'Düsseldorf', 'Leipzig', 'Dortmund', 'Essen', 'Dresden'],
  nl: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'The Hague', 'Delft', 'Groningen'],
  fr: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux', 'Lille', 'Nantes', 'Strasbourg'],
  es: ['Madrid', 'Barcelona', 'Seville', 'Valencia', 'Bilbao', 'Málaga', 'Zaragoza'],
  it: ['Milan', 'Rome', 'Turin', 'Florence', 'Bologna', 'Naples', 'Venice'],
  pl: ['Warsaw', 'Kraków', 'Wrocław', 'Poznań', 'Gdańsk', 'Łódź'],
  pt: ['Lisbon', 'Porto', 'Braga', 'Coimbra', 'Faro'],
  at: ['Vienna', 'Graz', 'Linz', 'Salzburg', 'Innsbruck'],
  ch: ['Zurich', 'Geneva', 'Bern', 'Basel', 'Lausanne'],
  se: ['Stockholm', 'Gothenburg', 'Malmö', 'Uppsala'],
  dk: ['Copenhagen', 'Aarhus', 'Odense', 'Aalborg'],
  fi: ['Helsinki', 'Espoo', 'Tampere', 'Oulu', 'Turku'],
  no: ['Oslo', 'Bergen', 'Trondheim', 'Stavanger'],
  be: ['Brussels', 'Antwerp', 'Ghent', 'Bruges', 'Liège'],
  cz: ['Prague', 'Brno', 'Ostrava', 'Plzeň'],
}

// ── City → country code map ───────────────────────────────────────────────────

const CITY_TO_COUNTRY: Record<string, string> = {}
for (const [code, cities] of Object.entries(COUNTRY_CITIES)) {
  for (const city of cities) {
    CITY_TO_COUNTRY[city.toLowerCase()] = code
  }
}

// Country name/alias → code
const COUNTRY_NAME_MAP: Record<string, string> = {
  // Ireland
  ireland: 'ie', 'republic of ireland': 'ie', irish: 'ie', 'eire': 'ie',
  'ireland (republic)': 'ie',
  // UK
  uk: 'gb', 'united kingdom': 'gb', england: 'gb', britain: 'gb', 'great britain': 'gb',
  scotland: 'gb', wales: 'gb',
  // Germany
  germany: 'de', deutschland: 'de', german: 'de',
  // Netherlands
  netherlands: 'nl', holland: 'nl', dutch: 'nl',
  // France
  france: 'fr', french: 'fr',
  // Spain
  spain: 'es', españa: 'es', spanish: 'es',
  // Italy
  italy: 'it', italia: 'it', italian: 'it',
  // Poland
  poland: 'pl', polska: 'pl', polish: 'pl',
  // Portugal
  portugal: 'pt', portuguese: 'pt',
  // Austria
  austria: 'at', österreich: 'at', austrian: 'at',
  // Switzerland
  switzerland: 'ch', schweiz: 'ch', suisse: 'ch',
  // Belgium
  belgium: 'be', belgique: 'be', belgien: 'be',
  // Sweden
  sweden: 'se', sverige: 'se', swedish: 'se',
  // Denmark
  denmark: 'dk', danmark: 'dk', danish: 'dk',
  // Finland
  finland: 'fi', suomi: 'fi', finnish: 'fi',
  // Norway
  norway: 'no', norge: 'no', norwegian: 'no',
  // Czech Republic
  'czech republic': 'cz', czechia: 'cz', czech: 'cz', 'česká republika': 'cz',
}

// Dublin-specific expansion (silicon docks, major tech campuses)
const DUBLIN_VARIANTS = [
  'Dublin', 'Ireland', 'IE',
  'Dublin 1', 'Dublin 2', 'Dublin 4', 'D2', 'D4',
  'Silicon Docks', 'Grand Canal Dock', 'Docklands',
  'Sandyford', 'Leopardstown', 'Citywest', 'Clonskeagh',
]

// Remote variations
const REMOTE_TERMS = ['Remote', 'remote', 'Anywhere', 'Worldwide', 'Work from home', 'WFH', 'Distributed']

// ── Main resolver ─────────────────────────────────────────────────────────────

export function resolveLocation(input: string): ResolvedLocation {
  const raw   = input.trim()
  const lower = raw.toLowerCase()

  // Remote
  if (/^(remote|anywhere|worldwide|distributed|wfh)$/i.test(lower)) {
    return {
      input, canonical: 'Remote', countryCode: null, isCountry: false, isRemote: true,
      searchTerms: ['remote'],
      dbTerms:     REMOTE_TERMS.map(t => t.toLowerCase()),
    }
  }

  // Try country name match
  const countryFromName = COUNTRY_NAME_MAP[lower]
  if (countryFromName) {
    const cities   = COUNTRY_CITIES[countryFromName] ?? []
    const canonical = raw.charAt(0).toUpperCase() + raw.slice(1)
    return {
      input, canonical, countryCode: countryFromName, isCountry: true, isRemote: false,
      // For API search: use the country name (let APIs handle city expansion)
      searchTerms: [canonical, ...cities.slice(0, 3)],
      // For DB: match any city OR country name
      dbTerms: [lower, countryFromName, ...cities.map(c => c.toLowerCase())],
    }
  }

  // Try city match
  const countryFromCity = CITY_TO_COUNTRY[lower]
  if (countryFromCity) {
    const countryName = Object.entries(COUNTRY_NAME_MAP).find(([, c]) => c === countryFromCity)?.[0] ?? ''
    const countryCities = COUNTRY_CITIES[countryFromCity] ?? []

    // Special Dublin expansion
    if (lower === 'dublin') {
      return {
        input, canonical: 'Dublin, Ireland', countryCode: 'ie', isCountry: false, isRemote: false,
        searchTerms: ['Dublin', 'Dublin, Ireland'],
        dbTerms: DUBLIN_VARIANTS.map(v => v.toLowerCase()),
      }
    }

    return {
      input, canonical: `${raw}, ${countryName}`,
      countryCode: countryFromCity, isCountry: false, isRemote: false,
      searchTerms: [raw, `${raw}, ${countryName}`],
      // DB: match this city + country name + country code + all sibling cities
      dbTerms: [lower, countryName.toLowerCase(), countryFromCity, ...countryCities.map(c => c.toLowerCase())],
    }
  }

  // Unknown: pass through as-is
  return {
    input, canonical: raw, countryCode: null, isCountry: false, isRemote: false,
    searchTerms: [raw],
    dbTerms: [lower],
  }
}

/**
 * Resolve multiple location inputs and merge the results.
 * e.g. ["Dublin", "Remote"] → combined dbTerms covering all variants
 */
export function resolveLocations(inputs: string[]): {
  resolved:    ResolvedLocation[]
  allDbTerms:  string[]
  allSearchTerms: string[]
  hasRemote:   boolean
  countryCodes: string[]
} {
  const resolved = inputs.map(resolveLocation)
  return {
    resolved,
    allDbTerms:     [...new Set(resolved.flatMap(r => r.dbTerms))],
    allSearchTerms: [...new Set(resolved.flatMap(r => r.searchTerms))],
    hasRemote:      resolved.some(r => r.isRemote),
    countryCodes:   [...new Set(resolved.map(r => r.countryCode).filter(Boolean) as string[])],
  }
}

/**
 * Build Prisma OR conditions for location matching.
 * Matches if job.location contains any of the resolved terms (case-insensitive).
 */
export function buildLocationWhere(inputs: string[]) {
  if (inputs.length === 0) return {}

  const { allDbTerms } = resolveLocations(inputs)
  if (allDbTerms.length === 0) return {}

  return {
    OR: [
      { location: null },
      { location: '' },
      ...allDbTerms.map(term => ({
        location: { contains: term, mode: 'insensitive' as const },
      })),
    ],
  }
}

/**
 * For logging: show what location was resolved to.
 */
export function locationSummary(inputs: string[]): string {
  if (inputs.length === 0) return '不限地点'
  const { resolved } = resolveLocations(inputs)
  return resolved.map(r => {
    if (r.isRemote) return '🌐 远程'
    if (r.isCountry) {
      const cities = COUNTRY_CITIES[r.countryCode ?? ''] ?? []
      return `🇺🇳 ${r.canonical}（${cities.slice(0, 3).join('、')}等）`
    }
    return `📍 ${r.canonical}`
  }).join(' + ')
}
