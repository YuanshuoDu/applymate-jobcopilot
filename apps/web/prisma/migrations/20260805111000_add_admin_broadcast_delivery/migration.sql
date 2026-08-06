CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'cancelled', 'failed');
CREATE TYPE "BroadcastAudienceType" AS ENUM ('all_active_users', 'plan', 'location', 'explicit_user_ids');

CREATE TABLE "AdminBroadcast" (
  "id" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL, "audienceType" "BroadcastAudienceType" NOT NULL,
  "audience" JSONB NOT NULL, "status" "BroadcastStatus" NOT NULL DEFAULT 'draft', "scheduledAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL, "approvedById" TEXT, "publishedById" TEXT, "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0, "failedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminBroadcast_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminBroadcast_status_scheduledAt_idx" ON "AdminBroadcast"("status", "scheduledAt");

ALTER TABLE "notifications" ADD COLUMN "broadcast_id" TEXT;
CREATE INDEX "notifications_broadcast_id_idx" ON "notifications"("broadcast_id");
CREATE UNIQUE INDEX "notifications_broadcast_id_user_id_key" ON "notifications"("broadcast_id", "user_id");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "AdminBroadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;
