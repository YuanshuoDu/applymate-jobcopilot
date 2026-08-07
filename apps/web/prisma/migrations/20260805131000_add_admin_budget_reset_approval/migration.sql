ALTER TABLE "ai_budget_adjustments" ADD COLUMN "previous_used" INTEGER;
ALTER TABLE "ai_budget_adjustments" ADD COLUMN "next_used" INTEGER;

CREATE TYPE "AiBudgetResetStatus" AS ENUM ('pending', 'approved', 'expired', 'cancelled');
CREATE TABLE "ai_budget_reset_requests" (
  "id" TEXT NOT NULL,
  "budget_id" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "approver_id" TEXT,
  "reason" TEXT NOT NULL,
  "status" "AiBudgetResetStatus" NOT NULL DEFAULT 'pending',
  "budget_version" INTEGER NOT NULL,
  "create_idempotency_key" TEXT NOT NULL,
  "approve_idempotency_key" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMP(3),
  CONSTRAINT "ai_budget_reset_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_budget_reset_requests_create_idempotency_key_key" ON "ai_budget_reset_requests"("create_idempotency_key");
CREATE UNIQUE INDEX "ai_budget_reset_requests_approve_idempotency_key_key" ON "ai_budget_reset_requests"("approve_idempotency_key");
CREATE INDEX "ai_budget_reset_requests_status_expires_at_idx" ON "ai_budget_reset_requests"("status", "expires_at");
ALTER TABLE "ai_budget_reset_requests" ADD CONSTRAINT "ai_budget_reset_requests_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "ai_budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
