ALTER TABLE "AdminBroadcast" ADD COLUMN "createIdempotencyKey" TEXT;
ALTER TABLE "AdminBroadcast" ADD COLUMN "publishIdempotencyKey" TEXT;
CREATE UNIQUE INDEX "AdminBroadcast_createIdempotencyKey_key" ON "AdminBroadcast"("createIdempotencyKey");
CREATE UNIQUE INDEX "AdminBroadcast_publishIdempotencyKey_key" ON "AdminBroadcast"("publishIdempotencyKey");
