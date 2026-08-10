CREATE TABLE "admin_notifications" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_notifications_dedupe_key_key" ON "admin_notifications"("dedupe_key");
CREATE INDEX "admin_notifications_admin_user_id_read_at_created_at_idx" ON "admin_notifications"("admin_user_id", "read_at", "created_at" DESC);
ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
