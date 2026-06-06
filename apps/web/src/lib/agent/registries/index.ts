/**
 * EU employer registries for ATS sources.
 *
 * Count summary (Issue #212): Greenhouse 45, Lever 45, Personio 35,
 * SmartRecruiters 25, Workday 33 active entries.
 *
 * Loads YAML files containing curated, verified employer slugs.
 * Each entry maps to a real company with >= 1 active job posting.
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 *      Issues #16 (Greenhouse), #17 (Lever), #18 (this registry)
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";

export interface WorkdayEmployer {
  name: string;
  tenant: string;
  siteId: string;
  baseUrl: string;
  /** ISO 3166-1 alpha-2 country code, lowercase */
  country: string;
  /** 1=Fortune 500, 2=large multinational, 3=regional */
  tier: 1 | 2 | 3;
  /** Verification status */
  status: "verified" | "pending" | "unreachable";
}

export interface Employer {
  slug: string;
  name: string;
  /** ISO 3166-1 alpha-2 country code, lowercase */
  country: string;
  /** 1=household name, 2=mid-size, 3=long-tail */
  tier: 1 | 2 | 3;
}

interface RegistryFile {
  employers: Employer[];
}

const REGISTRY_DIR = resolve(__dirname);

/** In-memory cache — YAML files are small, loaded once per process. */
const employerCache = new Map<string, Employer[]>()
const workdayCache = new Map<string, WorkdayEmployer[]>();

/**
 * Load the employer registry for a given ATS.
 *
 * YAML is read synchronously — the files are small and this runs
 * server-side at import time or on first call.
 */
export function loadRegistry(ats: "greenhouse" | "lever" | "smartrecruiters" | "personio"): Employer[] {
  const cached = employerCache.get(ats);
  if (cached) return cached;

  const file = resolve(REGISTRY_DIR, `${ats}.yaml`);
  const raw = readFileSync(file, "utf-8");
  const doc = load(raw) as RegistryFile;

  if (!doc?.employers || !Array.isArray(doc.employers)) {
    throw new Error(`Invalid registry: ${file} — missing or malformed "employers" key`);
  }

  employerCache.set(ats, doc.employers);
  return doc.employers;
}

/**
 * Load the Workday employer registry.
 *
 * Returns verified and pending entries. Unreachable entries
 * (those that returned 401/404/422 during verification) are filtered out.
 */
export function loadWorkdayRegistry(): WorkdayEmployer[] {
  const key = "workday"
  const cached = workdayCache.get(key)
  if (cached) return cached as WorkdayEmployer[]

  const file = resolve(REGISTRY_DIR, `${key}.yaml`)
  const raw = readFileSync(file, "utf-8")
  const doc = load(raw) as { employers: WorkdayEmployer[] }

  if (!doc?.employers || !Array.isArray(doc.employers)) {
    throw new Error(`Invalid registry: ${file} — missing or malformed "employers" key`)
  }

  // Only return employers that might work (skip unreachable)
  const active = doc.employers.filter(e => e.status !== "unreachable")
  workdayCache.set(key, active)
  return active
}

export interface EmployerFilter {
  /** ISO 3166-1 alpha-2 codes, lowercase */
  countries?: string[];
  /** Tier numbers to include */
  tiers?: number[];
}

/**
 * Filter an employer list by country and/or tier.
 *
 * Returns all employers if no filters are provided.
 */
export function filterEmployers(
  employers: Employer[],
  opts: EmployerFilter = {},
): Employer[] {
  return employers.filter((e) => {
    if (opts.countries?.length && !opts.countries.includes(e.country)) return false;
    if (opts.tiers?.length && !opts.tiers.includes(e.tier)) return false;
    return true;
  });
}
