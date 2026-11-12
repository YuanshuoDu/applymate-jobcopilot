ALTER TABLE "agent_sessions"
  ADD COLUMN "creationIdempotencyKey" VARCHAR(128),
  ADD COLUMN "creationIdempotencyRequestHash" VARCHAR(64);

CREATE UNIQUE INDEX "agent_sessions_userId_creationIdempotencyKey_key"
  ON "agent_sessions"("userId", "creationIdempotencyKey");
