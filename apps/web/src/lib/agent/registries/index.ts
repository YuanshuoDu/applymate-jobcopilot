/**
 * EU employer registries for Greenhouse and Lever ATS sources.
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
const cache = new Map<string, Employer[]>();

/**
 * Load the employer registry for a given ATS.
 *
 * YAML is read synchronously — the files are small and this runs
 * server-side at import time or on first call.
 */
export function loadRegistry(ats: "greenhouse" | "lever"): Employer[] {
  const cached = cache.get(ats);
  if (cached) return cached;

  const file = resolve(REGISTRY_DIR, `${ats}.yaml`);
  const raw = readFileSync(file, "utf-8");
  const doc = load(raw) as RegistryFile;

  if (!doc?.employers || !Array.isArray(doc.employers)) {
    throw new Error(`Invalid registry: ${file} — missing or malformed "employers" key`);
  }

  cache.set(ats, doc.employers);
  return doc.employers;
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
