ALTER TABLE "support_cases" ALTER COLUMN "requester_user_id" DROP NOT NULL;
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "requester_name" TEXT;
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "requester_email" TEXT;
CREATE INDEX IF NOT EXISTS "support_cases_requester_email_updatedAt_idx" ON "support_cases"("requester_email", "updatedAt" DESC);
