CREATE TYPE "PlanSubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'expired');

CREATE TABLE "user_plan_subscriptions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "plan" "Plan" NOT NULL,
  "status" "PlanSubscriptionStatus" NOT NULL DEFAULT 'active',
  "trial_starts_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "current_period_start" TIMESTAMP(3),
  "current_period_end" TIMESTAMP(3),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provider_customer_ref" TEXT,
  "provider_subscription_ref" TEXT,
  "updated_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_plan_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_plan_subscriptions_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "user_plan_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "user_plan_subscriptions_status_trial_ends_at_idx" ON "user_plan_subscriptions"("status", "trial_ends_at");
