CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'cancelled', 'failed');
CREATE TYPE "BroadcastAudienceType" AS ENUM ('all_active_users', 'plan', 'location', 'explicit_user_ids');
CREATE TYPE "SupportCaseStatus" AS ENUM ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed');
CREATE TYPE "SupportCasePriority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "SupportCaseMessageKind" AS ENUM ('customer_reply', 'staff_reply', 'internal_note', 'system_event');

ALTER TABLE "notifications" ADD COLUMN "broadcast_id" TEXT;
CREATE INDEX "notifications_broadcast_id_idx" ON "notifications"("broadcast_id");
CREATE UNIQUE INDEX "notifications_broadcast_id_user_id_key" ON "notifications"("broadcast_id", "user_id");

CREATE TABLE "AdminBroadcast" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "audienceType" "BroadcastAudienceType" NOT NULL,
  "audience" JSONB NOT NULL,
  "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
  "scheduledAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "approvedById" TEXT,
  "publishedById" TEXT,
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminBroadcast_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminBroadcast_status_scheduledAt_idx" ON "AdminBroadcast"("status", "scheduledAt");

CREATE TABLE "support_cases" (
  "id" TEXT NOT NULL,
  "requester_user_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "status" "SupportCaseStatus" NOT NULL DEFAULT 'open',
  "priority" "SupportCasePriority" NOT NULL DEFAULT 'normal',
  "assigned_admin_id" TEXT,
  "sla_due_at" TIMESTAMP(3),
  "first_responded_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "safe_context" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_cases_status_priority_sla_due_at_idx" ON "support_cases"("status", "priority", "sla_due_at");
CREATE INDEX "support_cases_requester_user_id_updated_at_idx" ON "support_cases"("requester_user_id", "updated_at" DESC);

CREATE TABLE "support_case_messages" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "author_type" "SupportCaseMessageKind" NOT NULL,
  "author_user_id" TEXT,
  "body" TEXT NOT NULL,
  "redacted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_case_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_case_messages_case_id_created_at_idx" ON "support_case_messages"("case_id", "created_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "AdminBroadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
