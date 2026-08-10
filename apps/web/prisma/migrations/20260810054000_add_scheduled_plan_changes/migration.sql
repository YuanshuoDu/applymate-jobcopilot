ALTER TABLE "user_plan_subscriptions" ADD COLUMN "scheduled_plan" "Plan";
ALTER TABLE "user_plan_subscriptions" ADD COLUMN "scheduled_at" TIMESTAMP(3);
CREATE INDEX "user_plan_subscriptions_scheduled_at_idx" ON "user_plan_subscriptions"("scheduled_at");
