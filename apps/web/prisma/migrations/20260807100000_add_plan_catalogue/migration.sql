-- CreateEnum
CREATE TYPE "public"."BillingInterval" AS ENUM ('forever', 'month', 'year');

-- CreateTable
CREATE TABLE "public"."plan_catalogue" (
    "id" TEXT NOT NULL,
    "plan" "public"."Plan" NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "interval" "public"."BillingInterval" NOT NULL DEFAULT 'month',
    "description" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "badge" TEXT,
    "cta" TEXT NOT NULL,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_catalogue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_catalogue_plan_key" ON "public"."plan_catalogue"("plan");
CREATE INDEX "plan_catalogue_active_sortOrder_idx" ON "public"."plan_catalogue"("active", "sortOrder");

-- Seed defaults so a migrated production database immediately has a public catalogue.
INSERT INTO "public"."plan_catalogue" ("id", "plan", "name", "priceMinor", "currency", "interval", "description", "features", "badge", "cta", "trialDays", "active", "sortOrder", "updatedAt")
VALUES
  ('plan_free_default', 'free', 'Free', 0, 'EUR', 'forever', 'Get started for free', '["5 applications/month", "Basic CV tailoring", "Job tracker (20 jobs)", "Extension popup"]', NULL, 'Get started free', 0, true, 0, CURRENT_TIMESTAMP),
  ('plan_pro_default', 'pro', 'Pro', 1200, 'EUR', 'month', 'Best for serious job seekers', '["Unlimited applications", "AI CV tailoring per role", "Unlimited tracker", "Full sidebar", "AI cover letters", "Gmail integration", "Priority support"]', 'Most popular', 'Start free trial', 14, true, 1, CURRENT_TIMESTAMP),
  ('plan_enterprise_default', 'enterprise', 'Team', 2900, 'EUR', 'month', 'For teams and recruiters', '["Everything in Pro", "5 team seats", "Shared job pool", "Analytics dashboard", "Custom AI model", "Dedicated support"]', NULL, 'Contact sales', 0, true, 2, CURRENT_TIMESTAMP);
