/**
 * Pinned local snapshot of ISO 3166-1 alpha-2 codes for Objective sponsorship scope.
 * Reference checked 2026-11-27: https://www.iso.org/iso-3166-country-codes.html
 * ISO identifies alpha-2 as the general-purpose form and the Maintenance Agency as
 * the authority for assigned codes. Reserved, withdrawn, and user-assigned values
 * are excluded; no runtime lookup or location inference is performed.
 */
export const ISO_3166_1_ALPHA_2_CODES = Object.freeze([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "YE", "YT",
  "ZA", "ZM", "ZW",
] as const)

export type Iso3166Alpha2CountryCode = typeof ISO_3166_1_ALPHA_2_CODES[number]

export const OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION =
  "agent-harness.v2.objective-sponsorship-target-country.v1" as const

export type ObjectiveSponsorshipTargetCountry = Readonly<{
  schemaVersion: typeof OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION
  countryCode: Iso3166Alpha2CountryCode
}>

const countryCodeSet: ReadonlySet<string> = new Set(ISO_3166_1_ALPHA_2_CODES)

export function isIso3166Alpha2CountryCode(value: unknown): value is Iso3166Alpha2CountryCode {
  return typeof value === "string" && countryCodeSet.has(value)
}

function exactDataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 2 ||
        keys.some(key => key !== "schemaVersion" && key !== "countryCode")) return null
    const schemaVersion = descriptors.schemaVersion
    const countryCode = descriptors.countryCode
    if (!schemaVersion || !("value" in schemaVersion) || !schemaVersion.enumerable ||
        !countryCode || !("value" in countryCode) || !countryCode.enumerable) return null
    return { schemaVersion: schemaVersion.value, countryCode: countryCode.value }
  } catch {
    return null
  }
}

/** Parses one explicit, versioned country selection; no normalization or inference is performed. */
export function parseObjectiveSponsorshipTargetCountry(value: unknown): ObjectiveSponsorshipTargetCountry | null {
  const record = exactDataRecord(value)
  if (!record || record.schemaVersion !== OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION ||
      !isIso3166Alpha2CountryCode(record.countryCode)) return null
  return Object.freeze({
    schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION,
    countryCode: record.countryCode,
  })
}
