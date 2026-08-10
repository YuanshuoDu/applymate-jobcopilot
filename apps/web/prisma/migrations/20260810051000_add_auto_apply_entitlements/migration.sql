UPDATE "plan_catalogue"
SET "entitlements" = "entitlements" || '["auto_apply"]'::jsonb
WHERE "plan" IN ('pro', 'enterprise')
  AND NOT ("entitlements" ? 'auto_apply');
