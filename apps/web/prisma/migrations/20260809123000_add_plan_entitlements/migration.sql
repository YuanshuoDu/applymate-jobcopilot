ALTER TABLE "plan_catalogue"
ADD COLUMN "entitlements" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "plan_catalogue"
SET "entitlements" = CASE "plan"
  WHEN 'free' THEN '["applications:5/month","cv:basic","tracker:20","extension:popup"]'::jsonb
  WHEN 'pro' THEN '["applications:unlimited","cv:tailoring","tracker:unlimited","extension:sidebar","cover_letters:ai","gmail:connected","support:priority"]'::jsonb
  WHEN 'enterprise' THEN '["plan:pro","seats:5","jobs:shared","analytics:dashboard","ai:custom_model","support:dedicated"]'::jsonb
  ELSE '[]'::jsonb
END;
