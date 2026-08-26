-- Keep the administrator budget ledger in sync with the existing AI telemetry.
-- Provider tests are not candidate credits, even when an admin actor id is
-- attached by the provider-test endpoint.
WITH monthly_usage AS (
  SELECT
    user_id,
    to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
    count(*)::integer AS used
  FROM ai_usage_events
  WHERE user_id IS NOT NULL
    AND feature_key <> 'providerTest'
  GROUP BY user_id, to_char(date_trunc('month', created_at), 'YYYY-MM')
)
INSERT INTO ai_budgets (id, user_id, month, used, "limit", created_at, updated_at)
SELECT
  'ai_budget_backfill_' || md5(monthly_usage.user_id || ':' || monthly_usage.month),
  monthly_usage.user_id,
  monthly_usage.month,
  monthly_usage.used,
  COALESCE(
    (
      SELECT substring(item FROM 'ai_credits:([0-9]+)')::integer
      FROM jsonb_array_elements_text(COALESCE(plan_catalogue.entitlements, '[]'::jsonb)) AS item
      WHERE item ~ '^ai_credits:[0-9]+'
      LIMIT 1
    ),
    CASE users.plan
      WHEN 'free' THEN 25
      WHEN 'pro' THEN 1000
      WHEN 'enterprise' THEN 10000
      ELSE 30
    END
  ),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM monthly_usage
JOIN "User" AS users ON users.id = monthly_usage.user_id
LEFT JOIN plan_catalogue ON plan_catalogue.plan::text = users.plan::text
ON CONFLICT (user_id, month) DO NOTHING;
