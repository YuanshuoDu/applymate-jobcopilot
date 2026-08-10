import { randomUUID } from "node:crypto";
import { getPool } from "./apply-results.js";

const MONTHLY_LIMIT = 30;

type BudgetPolicy = {
  configured: boolean;
  enabled: boolean;
  limit: number | null;
};

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function checkBudget(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const month = currentMonth();
  const pool = getPool();

  const policy = await loadBudgetPolicy(userId);
  const configuredLimit = policy?.configured && policy.limit !== null ? policy.limit : MONTHLY_LIMIT;

  await pool.query(
    `INSERT INTO ai_budgets (id, user_id, month, used, "limit", created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, NOW(), NOW())
     ON CONFLICT (user_id, month) DO NOTHING`,
    [randomUUID(), userId, month, configuredLimit]
  );

  if (policy?.configured && policy.limit !== null) {
    await pool.query(
      `UPDATE ai_budgets
       SET "limit" = $1,
           updated_at = NOW()
       WHERE user_id = $2 AND month = $3`,
      [policy.limit, userId, month]
    );
  }

  const result = await pool.query(
    `SELECT used, "limit" FROM ai_budgets WHERE user_id = $1 AND month = $2`,
    [userId, month]
  );
  const row = result.rows[0];

  return {
    allowed: policy?.configured ? policy.enabled && (policy.limit === null || row.used < policy.limit) : row.used < row.limit,
    used: Number(row.used),
    limit: policy?.configured && policy.limit !== null ? policy.limit : Number(row.limit),
  };
}

async function loadBudgetPolicy(userId: string): Promise<BudgetPolicy | null> {
  try {
    const result = await getPool().query(
      `SELECT
         CASE WHEN override.id IS NOT NULL THEN override.enabled ELSE plan_entitlement.value IS NOT NULL END AS enabled,
         CASE
           WHEN override.id IS NOT NULL THEN override.limit
           WHEN split_part(split_part(plan_entitlement.value, ':', 2), '/', 1) ~ '^[0-9]+$'
             THEN split_part(split_part(plan_entitlement.value, ':', 2), '/', 1)::integer
           ELSE NULL
         END AS configured_limit,
         (override.id IS NOT NULL OR plan_entitlement.value IS NOT NULL) AS configured
       FROM "User" AS candidate
       LEFT JOIN "plan_catalogue" AS plan ON plan.plan = candidate.plan
       LEFT JOIN "user_feature_overrides" AS override
         ON override."userId" = candidate.id
        AND override."featureKey" = 'ai_credits'
        AND (override."expiresAt" IS NULL OR override."expiresAt" > NOW())
       LEFT JOIN LATERAL (
         SELECT item.value
         FROM jsonb_array_elements_text(COALESCE(plan.entitlements, '[]'::jsonb)) AS item(value)
         WHERE split_part(item.value, ':', 1) = 'ai_credits'
         LIMIT 1
       ) AS plan_entitlement ON TRUE
       WHERE candidate.id = $1`,
      [userId]
    );
    const row = result.rows[0] as { enabled?: unknown; configured?: unknown; configured_limit?: unknown } | undefined;
    if (!row || row.configured !== true) return null;
    return {
      configured: true,
      enabled: row.enabled === true,
      limit: row.configured_limit === null || row.configured_limit === undefined ? null : Number(row.configured_limit),
    };
  } catch {
    // Keep older workers compatible while the catalogue migration is rolling out.
    return null;
  }
}

export async function incrementBudget(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE ai_budgets
     SET used = used + 1,
         updated_at = NOW()
     WHERE user_id = $1 AND month = $2`,
    [userId, currentMonth()]
  );
}
