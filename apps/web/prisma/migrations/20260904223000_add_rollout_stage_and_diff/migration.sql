-- AH2-051: durable, additive rollout control and metrics-only comparison facts.
CREATE TABLE "rollout_stage" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "stage_key" TEXT NOT NULL,
    "rollout_percent" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "internal_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "observation_started_at" TIMESTAMP(3),
    "observation_ends_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "rollback_reason" TEXT,
    "last_transition_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT NOT NULL DEFAULT 'system',
    "updated_by_id" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rollout_stage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rollout_stage_stage_key_check" CHECK ("stage_key" IN ('internal-only', '1%', '5%', '25%', '50%', '100%')),
    CONSTRAINT "rollout_stage_rollout_percent_check" CHECK ("rollout_percent" IN (0, 1, 5, 25, 50, 100)),
    CONSTRAINT "rollout_stage_status_check" CHECK ("status" IN ('active', 'rolled_back', 'blocked'))
);

CREATE UNIQUE INDEX "rollout_stage_environment_key" ON "rollout_stage"("environment");
CREATE INDEX "rollout_stage_environment_status_idx" ON "rollout_stage"("environment", "status");
CREATE INDEX "rollout_stage_stage_key_updated_at_idx" ON "rollout_stage"("stage_key", "updated_at");

-- The safe initial state is internal-only with no users. The migration is
-- idempotent so a deployment retry cannot reset an operator's stage.
INSERT INTO "rollout_stage" (
    "id", "environment", "stage_key", "rollout_percent", "enabled",
    "internal_user_ids", "observation_started_at", "observation_ends_at",
    "version", "status", "last_transition_at", "created_by_id", "updated_by_id"
)
VALUES
(
    'rollout-stage-development', 'development', 'internal-only', 0, true,
    ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours',
    1, 'active', CURRENT_TIMESTAMP, 'system', 'system'
),
(
    'rollout-stage-staging', 'staging', 'internal-only', 0, true,
    ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours',
    1, 'active', CURRENT_TIMESTAMP, 'system', 'system'
),
(
    'rollout-stage-production', 'production', 'internal-only', 0, true,
    ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours',
    1, 'active', CURRENT_TIMESTAMP, 'system', 'system'
)
ON CONFLICT ("environment") DO NOTHING;

CREATE TABLE "rollout_diff" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "stage_key" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "trace_id" TEXT,
    "metric_key" TEXT NOT NULL,
    "legacy_value" DOUBLE PRECISION NOT NULL,
    "v2_value" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "within_threshold" BOOLEAN NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rollout_diff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rollout_diff_metric_key_check" CHECK ("metric_key" IN ('turn_completion_rate', 'unauthorized_external_action', 'submission_duplicate', 'replay_consistency', 'cost_p95_ratio')),
    CONSTRAINT "rollout_diff_values_check" CHECK (
        "legacy_value" >= 0 AND "v2_value" >= 0 AND "delta" = "v2_value" - "legacy_value"
    )
);

CREATE UNIQUE INDEX "rollout_diff_comparison_metric_key" ON "rollout_diff"("comparison_id", "metric_key");
CREATE INDEX "rollout_diff_environment_stage_created_at_idx" ON "rollout_diff"("environment", "stage_key", "created_at");
CREATE INDEX "rollout_diff_session_created_at_idx" ON "rollout_diff"("session_id", "created_at");
CREATE INDEX "rollout_diff_metric_created_at_idx" ON "rollout_diff"("metric_key", "created_at");
