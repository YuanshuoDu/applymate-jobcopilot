CREATE TABLE "user_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adzunaAppId" TEXT,
    "adzunaAppKey" TEXT,
    "rapidapiKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_api_keys_userId_key" ON "user_api_keys"("userId");

ALTER TABLE "user_api_keys"
    ADD CONSTRAINT "user_api_keys_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
