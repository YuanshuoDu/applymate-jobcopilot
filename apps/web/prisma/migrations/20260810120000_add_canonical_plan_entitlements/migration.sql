UPDATE "plan_catalogue"
SET "entitlements" = "entitlements" || CASE "plan"
  WHEN 'free' THEN '["ai_credits:25", "job_discovery:20", "tailored_resume", "cover_letter:5"]'::jsonb
  WHEN 'pro' THEN '["ai_credits:1000", "job_discovery:1000", "tailored_resume", "cover_letter:100", "gmail_tracking"]'::jsonb
  WHEN 'enterprise' THEN '["ai_credits:10000", "job_discovery:10000", "tailored_resume", "cover_letter:1000", "gmail_tracking", "api_access"]'::jsonb
  ELSE '[]'::jsonb
END
WHERE NOT ("entitlements" ? 'ai_credits');
