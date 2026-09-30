-- One durable step reservation shared by every task in a root task tree.
CREATE TABLE "agent_tree_budget_reservations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "agent_tree_budget_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_tree_budget_reservations_identity_check" CHECK (
      octet_length("id") BETWEEN 1 AND 256
      AND octet_length("userId") BETWEEN 1 AND 256
      AND octet_length("sessionId") BETWEEN 1 AND 256
      AND octet_length("turnId") BETWEEN 1 AND 256
      AND octet_length("rootTaskId") BETWEEN 1 AND 256
      AND octet_length("taskId") BETWEEN 1 AND 256
      AND octet_length("stepId") BETWEEN 1 AND 256
      AND octet_length("idempotencyKey") BETWEEN 1 AND 256
    ),
    CONSTRAINT "agent_tree_budget_reservations_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "agent_tree_budget_reservations_units_check" CHECK ("units" = 1),
    CONSTRAINT "agent_tree_budget_reservations_status_check" CHECK ("status" IN ('reserved', 'consumed', 'released'))
);

CREATE UNIQUE INDEX "agent_tree_budget_reservations_identity_key"
  ON "agent_tree_budget_reservations"("rootTaskId", "taskId", "stepId", "attempt");
CREATE UNIQUE INDEX "agent_tree_budget_reservations_sessionId_idempotencyKey_key"
  ON "agent_tree_budget_reservations"("sessionId", "idempotencyKey");
CREATE INDEX "agent_tree_budget_reservations_userId_sessionId_turnId_rootTaskId_status_idx"
  ON "agent_tree_budget_reservations"("userId", "sessionId", "turnId", "rootTaskId", "status");
CREATE INDEX "agent_tree_budget_reservations_rootTaskId_status_createdAt_idx"
  ON "agent_tree_budget_reservations"("rootTaskId", "status", "createdAt");

ALTER TABLE "agent_tree_budget_reservations"
  ADD CONSTRAINT "agent_tree_budget_reservations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tree_budget_reservations_sessionId_userId_fkey"
    FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tree_budget_reservations_turnId_sessionId_userId_fkey"
    FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tree_budget_reservations_rootTaskId_sessionId_fkey"
    FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tree_budget_reservations_taskId_sessionId_fkey"
    FOREIGN KEY ("taskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_tree_budget_reservations_stepId_turnId_sessionId_fkey"
    FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tree_budget_reservations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tree_budget_reservation_user_isolation
  ON "agent_tree_budget_reservations"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
