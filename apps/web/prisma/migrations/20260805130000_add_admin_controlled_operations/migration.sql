ALTER TABLE "ai_budgets" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "support_cases" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "ai_budget_adjustments" (
  "id" TEXT NOT NULL,
  "budget_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "previous_limit" INTEGER NOT NULL,
  "next_limit" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_budget_adjustments_idempotency_key_key" ON "ai_budget_adjustments"("idempotency_key");
CREATE INDEX "ai_budget_adjustments_budget_id_created_at_idx" ON "ai_budget_adjustments"("budget_id", "created_at" DESC);
ALTER TABLE "ai_budget_adjustments" ADD CONSTRAINT "ai_budget_adjustments_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "ai_budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "AtsSourceState" AS ENUM ('enabled', 'degraded', 'pending_pause', 'paused', 'disabled');
CREATE TABLE "ats_source_policies" (
  "id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "state" "AtsSourceState" NOT NULL DEFAULT 'enabled',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "rollout_percent" INTEGER NOT NULL DEFAULT 100,
  "global_rps_limit" INTEGER NOT NULL,
  "per_tenant_rps_limit" INTEGER NOT NULL,
  "max_retries" INTEGER NOT NULL DEFAULT 3,
  "backoff_base_ms" INTEGER NOT NULL DEFAULT 1000,
  "allow_auto_apply" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "last_changed_by_id" TEXT NOT NULL,
  "last_acknowledged_version" INTEGER,
  "pause_requested_by_id" TEXT,
  "pause_approved_by_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ats_source_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ats_source_policies_source_key_key" ON "ats_source_policies"("source_key");
CREATE INDEX "ats_source_policies_state_updated_at_idx" ON "ats_source_policies"("state", "updated_at" DESC);

CREATE TABLE "admin_idempotency_keys" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "target_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_idempotency_keys_actor_user_id_action_idempotency_key_key" ON "admin_idempotency_keys"("actor_user_id", "action", "idempotency_key");
