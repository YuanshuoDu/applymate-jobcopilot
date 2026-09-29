ALTER TABLE "agent_artifact"
  ADD CONSTRAINT "agent_artifact_id_userId_jobId_key" UNIQUE ("id", "userId", "jobId");

CREATE TABLE "agent_artifact_version" (
  "id" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "artifactType" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "constraintHash" TEXT NOT NULL,
  "provenanceRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidenceRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "baseId" TEXT NOT NULL,
  "baseHash" TEXT NOT NULL,
  "previousHash" TEXT,
  "taskId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_artifact_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_artifact_version_version_positive" CHECK ("version" > 0),
  CONSTRAINT "agent_artifact_version_hashes_valid" CHECK (
    "contentHash" ~ '^sha256:[a-f0-9]{64}$' AND
    "sourceDigest" ~ '^sha256:[a-f0-9]{64}$' AND
    "requestHash" ~ '^sha256:[a-f0-9]{64}$' AND
    "baseHash" ~ '^sha256:[a-f0-9]{64}$' AND
    ("previousHash" IS NULL OR "previousHash" ~ '^sha256:[a-f0-9]{64}$')
  ),
  CONSTRAINT "agent_artifact_versions_artifact_scope_fkey"
    FOREIGN KEY ("artifactId", "userId", "jobId")
    REFERENCES "agent_artifact"("id", "userId", "jobId") ON DELETE CASCADE,
  CONSTRAINT "agent_artifact_versions_session_user_fkey"
    FOREIGN KEY ("sessionId", "userId")
    REFERENCES "agent_sessions"("id", "userId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "agent_artifact_version_review_ref_key"
  ON "agent_artifact_version"("id", "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest");

CREATE TABLE "agent_artifact_review" (
  "id" TEXT NOT NULL,
  "artifactVersionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "currentSourceDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "findings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "evidenceRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "taskId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reviewHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_artifact_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_artifact_review_status_valid" CHECK ("status" IN ('passed', 'needs_revision', 'rejected', 'stale')),
  CONSTRAINT "agent_artifact_review_hashes_valid" CHECK (
    "contentHash" ~ '^sha256:[a-f0-9]{64}$' AND
    "sourceDigest" ~ '^sha256:[a-f0-9]{64}$' AND
    "currentSourceDigest" ~ '^sha256:[a-f0-9]{64}$' AND
    "requestHash" ~ '^sha256:[a-f0-9]{64}$' AND
    "reviewHash" ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT "agent_artifact_reviews_version_scope_fkey"
    FOREIGN KEY ("artifactVersionId", "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest")
    REFERENCES "agent_artifact_version"("id", "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "agent_artifact_version_artifact_version_key"
  ON "agent_artifact_version"("artifactId", "version");
CREATE UNIQUE INDEX "agent_artifact_version_task_tool_key"
  ON "agent_artifact_version"("taskId", "toolCallId");
CREATE INDEX "agent_artifact_version_scope_lookup_idx"
  ON "agent_artifact_version"("userId", "sessionId", "jobId", "artifactId", "version");
CREATE UNIQUE INDEX "agent_artifact_review_task_tool_key"
  ON "agent_artifact_review"("taskId", "toolCallId");
CREATE INDEX "agent_artifact_review_scope_lookup_idx"
  ON "agent_artifact_review"("userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest");

CREATE FUNCTION "reject_agent_artifact_version_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent artifact versions are immutable';
END;
$$;
CREATE TRIGGER "agent_artifact_version_immutable"
  BEFORE UPDATE ON "agent_artifact_version"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_artifact_version_mutation"();
CREATE TRIGGER "agent_artifact_review_immutable"
  BEFORE UPDATE ON "agent_artifact_review"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_artifact_version_mutation"();

ALTER TABLE "agent_artifact_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_artifact_review" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "candidate_agent_artifact_version_isolation" ON "agent_artifact_version"
  USING ("userId" = app_current_user_id())
  WITH CHECK ("userId" = app_current_user_id());
CREATE POLICY "candidate_agent_artifact_review_isolation" ON "agent_artifact_review"
  USING ("userId" = app_current_user_id())
  WITH CHECK ("userId" = app_current_user_id());
