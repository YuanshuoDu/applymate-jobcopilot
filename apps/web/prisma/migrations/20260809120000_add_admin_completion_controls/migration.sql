-- Completion controls for access review, deletion operations, support operations,
-- and observable alert state. All records contain operational metadata only.

CREATE TABLE "admin_access_reviews" (
  "id" TEXT NOT NULL,
  "membership_id" TEXT NOT NULL,
  "reviewer_id" TEXT NOT NULL,
  "cycle_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "due_at" TIMESTAMP(3) NOT NULL,
  "reviewed_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_access_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_access_reviews_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_access_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "admin_access_reviews_membership_id_cycle_key_key" ON "admin_access_reviews"("membership_id", "cycle_key");
CREATE INDEX "admin_access_reviews_status_due_at_idx" ON "admin_access_reviews"("status", "due_at");

CREATE TABLE "admin_data_deletion_requests" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "reason" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "processed_by_id" TEXT,
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_data_deletion_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_data_deletion_requests_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "admin_data_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_data_deletion_requests_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "admin_data_deletion_requests_status_requested_at_idx" ON "admin_data_deletion_requests"("status", "requested_at" DESC);

CREATE TABLE "admin_alert_rules" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "window_min" INTEGER NOT NULL,
  "severity" "AdminIncidentSeverity" NOT NULL DEFAULT 'medium',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "last_fired_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_alert_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_alert_rules_key_key" UNIQUE ("key")
);
CREATE INDEX "admin_alert_rules_enabled_metric_idx" ON "admin_alert_rules"("enabled", "metric");

CREATE TABLE "admin_alert_events" (
  "id" TEXT NOT NULL,
  "rule_key" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "severity" "AdminIncidentSeverity" NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "incident_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "admin_alert_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_alert_events_status_created_at_idx" ON "admin_alert_events"("status", "created_at" DESC);

CREATE TABLE "support_case_escalations" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "incident_id" TEXT,
  "service" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_case_escalations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_case_escalations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "support_case_escalations_case_id_created_at_idx" ON "support_case_escalations"("case_id", "created_at" DESC);

CREATE TABLE "support_sla_policies" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "priority" "SupportCasePriority" NOT NULL,
  "first_response_minutes" INTEGER NOT NULL,
  "resolution_minutes" INTEGER NOT NULL,
  "warning_minutes" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_sla_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "support_sla_policies_category_priority_key" ON "support_sla_policies"("category", "priority");
CREATE INDEX "support_sla_policies_active_category_idx" ON "support_sla_policies"("active", "category");

CREATE TABLE "support_macros" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT,
  "body" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_macros_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_macros_active_category_idx" ON "support_macros"("active", "category");
