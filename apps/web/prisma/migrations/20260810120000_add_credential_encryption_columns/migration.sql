ALTER TABLE "Account"
  ADD COLUMN "refreshTokenEnc" TEXT,
  ADD COLUMN "accessTokenEnc" TEXT,
  ADD COLUMN "idTokenEnc" TEXT;

ALTER TABLE "user_api_keys"
  ADD COLUMN "adzunaAppIdEnc" TEXT,
  ADD COLUMN "adzunaAppKeyEnc" TEXT,
  ADD COLUMN "rapidapiKeyEnc" TEXT;
