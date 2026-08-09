-- Admin operations core: user lifecycle and platform AI catalogue.
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'plan';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'admin_role';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_provider';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_model';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_route';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'incident';

CREATE TYPE "UserAccountStatus" AS ENUM ('active', 'suspended');

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "UserAccountStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedById" TEXT,
  ADD COLUMN "suspensionReason" TEXT;

CREATE TABLE "user_plan_changes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromPlan" "Plan" NOT NULL,
  "toPlan" "Plan" NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_plan_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_plan_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "user_plan_changes_userId_createdAt_idx" ON "user_plan_changes"("userId", "createdAt" DESC);

CREATE TABLE "user_feature_overrides" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "limit" INTEGER,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_feature_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_feature_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_feature_overrides_userId_featureKey_key" ON "user_feature_overrides"("userId", "featureKey");
CREATE INDEX "user_feature_overrides_userId_expiresAt_idx" ON "user_feature_overrides"("userId", "expiresAt");

CREATE TABLE "ai_provider_configs" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "apiBase" TEXT NOT NULL,
  "secretRef" TEXT,
  "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_provider_configs_key_key" ON "ai_provider_configs"("key");

CREATE TABLE "ai_model_configs" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "tier" TEXT NOT NULL,
  "priceIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "priceOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "contextK" INTEGER NOT NULL DEFAULT 128,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "ai_model_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_configs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_provider_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ai_model_configs_providerId_model_key" ON "ai_model_configs"("providerId", "model");
CREATE INDEX "ai_model_configs_providerId_active_idx" ON "ai_model_configs"("providerId", "active");

CREATE TABLE "ai_route_configs" (
  "id" TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "defaultProvider" TEXT NOT NULL,
  "defaultModel" TEXT NOT NULL,
  "fallbackProvider" TEXT,
  "fallbackModel" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_route_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_route_configs_featureKey_key" ON "ai_route_configs"("featureKey");
