-- Keep the deletion queue record as an operational tombstone after the user row
-- is erased. This preserves the audit trail without retaining user data.
ALTER TABLE "admin_data_deletion_requests"
  DROP CONSTRAINT "admin_data_deletion_requests_user_id_fkey";
ALTER TABLE "admin_data_deletion_requests"
  ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "admin_data_deletion_requests"
  ADD CONSTRAINT "admin_data_deletion_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "data_retention_policies" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "retention_days" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "data_retention_policies_key_key" ON "data_retention_policies"("key");
CREATE INDEX "data_retention_policies_enabled_key_idx" ON "data_retention_policies"("enabled", "key");

INSERT INTO "data_retention_policies" ("id", "key", "name", "retention_days", "updated_at")
VALUES ('retention_completed_deletions', 'completed_deletion_requests', 'Completed deletion queue records', 90, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
