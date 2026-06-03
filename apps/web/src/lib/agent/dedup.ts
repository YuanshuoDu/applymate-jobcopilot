/**
 * Multi-source job deduplication.
 *
 * With 5+ discovery sources (Greenhouse, Lever, Workday, SmartRecruiters,
 * Personio) all feeding the same job pool, the same role often appears
 * from multiple sources. This module normalizes company, title, and location
 * into a stable key, then keeps the best-quality record when duplicates
 * are found (preferring records with full descriptions).
 *
 * See: Issue #158, docs/scraping-autoapply-design.md
 */

import type { DiscoveredJob } from "./discover"

// ── Legal suffix stripping ────────────────────────────────────────────────────

const LEGAL_SUFFIXES = [
  "ag", "gmbh", "b.v.", "bv", "ltd", "inc", "corp", "se",
  "s.a.", "sa", "s.l.", "sl", "nv", "oyj", "aps", "as", "ab",
  "llc", "plc", "kg", "ohg", "e.k.", "kgaa", "ug", "sarl",
  "sp. z o.o.", "sp z oo", "s.r.l.", "srl", "s.a.s.", "sas",
  "pty ltd", "pte ltd", "co.", "co", "limited", "corporation",
  "incorporated", "holding", "holdings", "group",
]

/** Strip commas, slashes, parens etc. — but keep dots (meaningful in "Booking.com"). */
function stripPunctuation(s: string): string {
  return s.replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim()
}

// ── Nationality terms to strip ────────────────────────────────────────────────

const NATIONALITY_PREFIXES = /^(deutsch|german|french|franzosisch|british|english|dutch|niederlandisch|swiss|schweizer|austrian|osterreichisch|spanish|spanisch|italian|italienisch|polish|polnisch|swedish|schwedisch|danish|danisch|finnish|finnisch|norwegian|norwegisch|belgian|belgisch|portuguese|portugiesisch|irish|irisch|czech|tschechisch|hungarian|ungarisch|romanian|rumanisch|greek|griechisch|)\s+/i

// ── Umlaut → ASCII ────────────────────────────────────────────────────────────

function replaceUmlauts(s: string): string {
  return s
    .replace(/ü/g, "ue").replace(/ö/g, "oe").replace(/ä/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/Ü/g, "ue").replace(/Ö/g, "oe").replace(/Ä/g, "ae")
    .replace(/é/g, "e").replace(/è/g, "e").replace(/ê/g, "e").replace(/ë/g, "e")
    .replace(/á/g, "a").replace(/à/g, "a").replace(/â/g, "a")
    .replace(/í/g, "i").replace(/ì/g, "i").replace(/î/g, "i")
    .replace(/ó/g, "o").replace(/ò/g, "o").replace(/ô/g, "o")
    .replace(/ú/g, "u").replace(/ù/g, "u").replace(/û/g, "u")
    .replace(/ñ/g, "n").replace(/ç/g, "c")
}

// ── Gendered title suffix removal ─────────────────────────────────────────────

const GENDER_SUFFIXES = [
  "(m/f/d)", "(m/w/d)", "(m/f/x)", "(d/f/m)", "(w/m/d)",
  "(all genders)", "(m/w/x)", "(m/w)", "(f/m)", "(m/f)",
  "(m/f/div)", "(w/m/x)", "(divers)",
]

const SENIORITY_PREFIX = /^\((senior|junior|lead|principal|staff|head of|director of)\)\s*/i

// ── Known city normalizations ─────────────────────────────────────────────────

const CITY_NORMALIZE: Record<string, string> = {
  "munchen": "munich", "muenchen": "munich",
  "koln": "cologne", "koeln": "cologne",
  "dusseldorf": "dusseldorf", "duesseldorf": "dusseldorf",
  "zurich": "zurich", "zuerich": "zurich",
  "geneve": "geneva", "genf": "geneva",
  "wien": "vienna",
  "warszawa": "warsaw", "warschau": "warsaw",
  "krakow": "krakow", "krakau": "krakow",
  "gdansk": "gdansk", "danzig": "gdansk",
  "praha": "prague", "prag": "prague",
  "kobenhavn": "copenhagen", "kopenhagen": "copenhagen",
  "brussel": "brussels", "bruxelles": "brussels",
  "lisboa": "lisbon",
  "milano": "milan", "mailand": "milan",
  "roma": "rome", "rom": "rome",
  "torino": "turin",
  "firenze": "florence",
}

// Countries/regions to strip when ≥3 words (city + region + country present)
const COUNTRIES = /\b(germany|deutschland|bayern|bavaria|france|spain|italy|netherlands|belgium|austria|switzerland|poland|portugal|sweden|denmark|finland|norway|ireland|czech|hungary|romania|greece|united kingdom|uk|usa|united states)\b/gi

// ── Public API ────────────────────────────────────────────────────────────────

export function normalizeCompany(name: string): string {
  let s = name.toLowerCase().trim()
  s = s.replace(NATIONALITY_PREFIXES, "")
  // Remove legal suffixes before punctuation stripping (so "B.V." with dots matches)
  for (const suffix of LEGAL_SUFFIXES) {
    const re = new RegExp("\\b" + suffix.replace(/\./g, "\\.") + "(?=\\b|$)", "gi")
    s = s.replace(re, "")
  }
  s = stripPunctuation(s)
  // Merge dotted word fragments: "booking com" -> "bookingcom"
  s = s.replace(/\b([a-z0-9]+)\s+([a-z0-9]+)\b/gi, "$1$2")
  return s.replace(/\s+/g, " ").trim()
}

export function normalizeTitle(title: string): string {
  let s = title.toLowerCase().trim()
  for (const sfx of GENDER_SUFFIXES) {
    s = s.replace(sfx.toLowerCase(), "")
  }
  s = s.replace(SENIORITY_PREFIX, "")
  s = s.replace(/[()]/g, " ")
  s = s.replace(/[,/#!$%^&*;:{}=_`~'"\[\]\\-]/g, " ")
  return s.replace(/\s+/g, " ").trim()
}

export function normalizeLocation(loc: string): string {
  let s = loc.toLowerCase().trim()
  s = replaceUmlauts(s)
  s = s.replace(/[,/]/g, " ")
  s = s.replace(/\s+/g, " ").trim()
  for (const [variant, canonical] of Object.entries(CITY_NORMALIZE)) {
    s = s.replace(new RegExp("\\b" + variant + "(?=\\b|$)", "gi"), canonical)
  }
    // Strip known country/region names
  s = s.replace(COUNTRIES, "")
  return s.replace(/\s+/g, " ").trim()
}

function buildKey(job: DiscoveredJob): string {
  return [
    normalizeCompany(job.company),
    normalizeTitle(job.title),
    normalizeLocation(job.location),
  ].join("|")
}

export function dedupJobs(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const seen = new Map<string, DiscoveredJob>()

  for (const job of jobs) {
    const key = buildKey(job)
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, job)
      continue
    }

    const newLen = job.description?.length ?? 0
    const oldLen = existing.description?.length ?? 0
    const newHasDesc = newLen >= 200
    const oldHasDesc = oldLen >= 200

    if (newHasDesc && !oldHasDesc) {
      seen.set(key, job)
    } else if (newHasDesc && oldHasDesc && newLen > oldLen) {
      seen.set(key, job)
    }
  }

  return Array.from(seen.values())
}
