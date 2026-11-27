import { describe, expect, it } from "vitest"

import {
  ISO_3166_1_ALPHA_2_CODES,
  OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION,
  isIso3166Alpha2CountryCode,
  parseObjectiveSponsorshipTargetCountry,
} from "./objective-sponsorship-target-country.js"

describe("Objective sponsorship target country", () => {
  it("keeps a sorted, unique snapshot of the 249 assigned ISO 3166-1 alpha-2 codes", () => {
    expect(ISO_3166_1_ALPHA_2_CODES).toHaveLength(249)
    expect(new Set(ISO_3166_1_ALPHA_2_CODES).size).toBe(ISO_3166_1_ALPHA_2_CODES.length)
    expect([...ISO_3166_1_ALPHA_2_CODES].sort()).toEqual(ISO_3166_1_ALPHA_2_CODES)
    expect(ISO_3166_1_ALPHA_2_CODES).toContain("IE")
    expect(ISO_3166_1_ALPHA_2_CODES).toContain("BQ")
  })

  it.each(["UK", "XK", "EU", "SU", "AN", "ZZ", "ie", "I", "IRL", ""])(
    "rejects unsupported or non-canonical code %s",
    code => expect(isIso3166Alpha2CountryCode(code)).toBe(false),
  )

  it("parses only the closed versioned selection shape", () => {
    expect(parseObjectiveSponsorshipTargetCountry({
      schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION,
      countryCode: "IE",
    })).toEqual({ schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: "IE" })
    expect(parseObjectiveSponsorshipTargetCountry({
      countryCode: "IE", schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION,
    })).toEqual({ schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: "IE" })
    for (const value of [
      null,
      { schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: "XK" },
      { schemaVersion: "unknown", countryCode: "IE" },
      { schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: "IE", extra: true },
    ]) expect(parseObjectiveSponsorshipTargetCountry(value)).toBeNull()
  })
})
