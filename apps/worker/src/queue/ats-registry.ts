import type { Pool } from 'pg'

export type DiscoveryRegistrySource = 'greenhouse' | 'lever'

type RegistryRow = { slug: unknown }

function isStagedSchemaError(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return error.code === '42P01' || error.code === '42703'
}

/**
 * Load the enabled employer slugs that Worker discovery must use.
 *
 * The code-owned fallback is used only while the registry migration is being
 * staged. Once the table has the enabled column, an empty result is deliberate
 * and stops discovery for that source.
 */
export async function loadEnabledAtsSlugs(
  pool: Pool,
  sourceKey: DiscoveryRegistrySource,
  stagedFallback: readonly string[],
): Promise<string[]> {
  try {
    const result = await pool.query<RegistryRow>(
      'SELECT "slug" FROM "ats_employers" WHERE "atsType" = $1 AND "enabled" = true ORDER BY "slug" ASC',
      [sourceKey],
    )
    const slugs = result.rows
      .map(row => typeof row.slug === 'string' ? row.slug.trim() : '')
      .filter(slug => /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,100}$/.test(slug))
    return [...new Set(slugs)]
  } catch (error) {
    if (isStagedSchemaError(error)) return [...new Set(stagedFallback)]
    throw new Error(`ATS registry lookup failed for ${sourceKey}`, { cause: error })
  }
}
