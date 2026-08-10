CREATE TYPE "UserAccountStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "PlanEntitlementKind" AS ENUM ('boolean', 'limit', 'text');

ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'plan';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'plan_change';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_provider';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_model';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ai_route';
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'admin_role';

ALTER TABLE "AdminRole" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "UserAccountStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedById" TEXT,
  ADD COLUMN "suspensionReason" TEXT;

CREATE TABLE "PlanCatalog" (
  "id" TEXT NOT NULL,
  "plan" "Plan" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
  "yearlyPriceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlanCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanCatalog_plan_key" ON "PlanCatalog"("plan");

CREATE TABLE "PlanEntitlement" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "kind" "PlanEntitlementKind" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "limit" INTEGER,
  "textValue" TEXT,
  CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanEntitlement_planId_featureKey_key" ON "PlanEntitlement"("planId", "featureKey");

CREATE TABLE "PlanTransition" (
  "id" TEXT NOT NULL,
  "fromPlan" "Plan" NOT NULL,
  "toPlan" "Plan" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlanTransition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanTransition_fromPlan_toPlan_key" ON "PlanTransition"("fromPlan", "toPlan");

CREATE TABLE "UserPlanChange" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromPlan" "Plan" NOT NULL,
  "toPlan" "Plan" NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPlanChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserPlanChange_userId_createdAt_idx" ON "UserPlanChange"("userId", "createdAt" DESC);

CREATE TABLE "UserFeatureOverride" (
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
  CONSTRAINT "UserFeatureOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserFeatureOverride_userId_featureKey_key" ON "UserFeatureOverride"("userId", "featureKey");

ALTER TABLE "PlanEntitlement" ADD CONSTRAINT "PlanEntitlement_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "PlanCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanTransition" ADD CONSTRAINT "PlanTransition_fromPlan_fkey"
  FOREIGN KEY ("fromPlan") REFERENCES "PlanCatalog"("plan") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanTransition" ADD CONSTRAINT "PlanTransition_toPlan_fkey"
  FOREIGN KEY ("toPlan") REFERENCES "PlanCatalog"("plan") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserPlanChange" ADD CONSTRAINT "UserPlanChange_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserFeatureOverride" ADD CONSTRAINT "UserFeatureOverride_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
