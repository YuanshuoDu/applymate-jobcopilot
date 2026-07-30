-- Separate internal application preparation from the candidate-facing lifecycle.
CREATE TYPE "JobWorkflowState" AS ENUM ('draft', 'ready_to_apply', 'submitted');

ALTER TABLE "Job"
  ADD COLUMN "workflowState" "JobWorkflowState" NOT NULL DEFAULT 'draft';

-- The old `review` value meant "ready for the candidate to apply" in some
-- paths. Preserve that internal intent while removing an unverifiable external
-- application state from the public lifecycle.
UPDATE "Job"
  SET "workflowState" = 'ready_to_apply'
  WHERE "status"::text = 'review';

ALTER TABLE "Job" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
CREATE TYPE "JobStatus" AS ENUM ('saved', 'applied', 'interview', 'offer', 'rejected');
ALTER TABLE "Job"
  ALTER COLUMN "status" TYPE "JobStatus"
  USING (CASE WHEN "status"::text = 'review' THEN 'saved' ELSE "status"::text END)::"JobStatus";
ALTER TABLE "Job" ALTER COLUMN "status" SET DEFAULT 'saved';
DROP TYPE "JobStatus_old";

CREATE TYPE "GmailMessageKind" AS ENUM (
  'application_received',
  'interview_invitation',
  'offer',
  'rejection',
  'application_update',
  'recommendation_digest',
  'other'
);

CREATE TYPE "GmailRecommendationStatus" AS ENUM ('pending', 'saved', 'dismissed');

CREATE TABLE "gmail_sync_states" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "last_synced_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmail_sync_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_sync_states_user_id_key" ON "gmail_sync_states"("user_id");

CREATE TABLE "gmail_messages" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "gmail_message_id" TEXT NOT NULL,
  "gmail_thread_id" TEXT,
  "kind" "GmailMessageKind" NOT NULL,
  "sender_email" TEXT,
  "sender_name" TEXT,
  "subject" TEXT NOT NULL,
  "excerpt" TEXT,
  "inferred_company" TEXT,
  "inferred_role" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL,
  "job_id" TEXT,
  "match_confidence" DOUBLE PRECISION,
  "manually_linked" BOOLEAN NOT NULL DEFAULT false,
  "processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmail_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_messages_user_id_gmail_message_id_key"
  ON "gmail_messages"("user_id", "gmail_message_id");
CREATE INDEX "gmail_messages_user_id_received_at_idx"
  ON "gmail_messages"("user_id", "received_at" DESC);
CREATE INDEX "gmail_messages_user_id_job_id_received_at_idx"
  ON "gmail_messages"("user_id", "job_id", "received_at" DESC);

CREATE TABLE "gmail_recommendations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "platform" TEXT,
  "company" TEXT,
  "role" TEXT,
  "location" TEXT,
  "salary" TEXT,
  "url" TEXT,
  "description" TEXT,
  "fingerprint" TEXT NOT NULL,
  "status" "GmailRecommendationStatus" NOT NULL DEFAULT 'pending',
  "saved_job_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmail_recommendations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_recommendations_user_id_fingerprint_key"
  ON "gmail_recommendations"("user_id", "fingerprint");
CREATE INDEX "gmail_recommendations_user_id_status_created_at_idx"
  ON "gmail_recommendations"("user_id", "status", "created_at" DESC);

ALTER TABLE "gmail_sync_states"
  ADD CONSTRAINT "gmail_sync_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gmail_messages"
  ADD CONSTRAINT "gmail_messages_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gmail_messages"
  ADD CONSTRAINT "gmail_messages_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gmail_recommendations"
  ADD CONSTRAINT "gmail_recommendations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gmail_recommendations"
  ADD CONSTRAINT "gmail_recommendations_source_message_id_fkey"
  FOREIGN KEY ("source_message_id") REFERENCES "gmail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gmail_recommendations"
  ADD CONSTRAINT "gmail_recommendations_saved_job_id_fkey"
  FOREIGN KEY ("saved_job_id") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Notification is in the Prisma schema but older deployments may not have
-- received its table migration. Create it safely before Gmail sync writes daily
-- recommendation alerts.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "job_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notifications_user_id_created_at_idx"
  ON "notifications"("user_id", "created_at" DESC);
