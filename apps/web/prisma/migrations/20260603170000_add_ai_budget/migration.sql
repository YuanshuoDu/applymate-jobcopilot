-- AiBudget was introduced before the administrative budget controls. Keep this
-- migration before those controls so a fresh database has the dependency.
CREATE TABLE IF NOT EXISTS "ai_budgets" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "limit" INTEGER NOT NULL DEFAULT 30,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_budgets_user_id_month_key" ON "ai_budgets"("user_id", "month");
