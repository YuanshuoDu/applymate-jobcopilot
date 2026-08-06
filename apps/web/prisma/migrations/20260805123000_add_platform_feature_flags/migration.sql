CREATE TYPE "FeatureFlagStatus" AS ENUM ('draft', 'pending_approval', 'active', 'retired');

CREATE TABLE "PlatformFeatureFlag" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
  "targetPlans" "Plan"[],
  "targetUserIds" TEXT[],
  "status" "FeatureFlagStatus" NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "approvedById" TEXT,
  "updatedById" TEXT NOT NULL,
  "rollbackAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformFeatureFlag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformFeatureFlag_key_environment_key" ON "PlatformFeatureFlag"("key", "environment");
CREATE INDEX "PlatformFeatureFlag_environment_status_idx" ON "PlatformFeatureFlag"("environment", "status");
