CREATE TABLE "admin_broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admin_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_broadcast_deliveries_broadcast_id_user_id_key" ON "admin_broadcast_deliveries"("broadcast_id", "user_id");
CREATE INDEX "admin_broadcast_deliveries_broadcast_id_status_updated_at_idx" ON "admin_broadcast_deliveries"("broadcast_id", "status", "updated_at");
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "AdminBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_broadcast_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admin_broadcast_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_broadcast_templates_active_updated_at_idx" ON "admin_broadcast_templates"("active", "updated_at" DESC);
