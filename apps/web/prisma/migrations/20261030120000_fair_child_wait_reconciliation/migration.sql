ALTER TABLE "agent_wait_conditions"
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3);

-- Prisma cannot represent this partial expression index. Keep the matching
-- AgentWaitCondition field in schema.prisma; verify drift against this SQL.
CREATE INDEX "agent_wait_conditions_child_wait_due_idx"
  ON "agent_wait_conditions" (
    "sessionId",
    (COALESCE("nextReconcileAt", "suspendedAt")),
    "createdAt",
    "id"
  )
  WHERE "status" = 'waiting'
    AND "suspendedAt" IS NOT NULL
    AND "consumedAt" IS NULL;
