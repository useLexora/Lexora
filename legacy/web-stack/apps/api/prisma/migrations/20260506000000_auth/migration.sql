-- AlterTable
ALTER TABLE "SystemAuthConfig" ADD COLUMN "allowGithubLogin" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "allowLinuxDoLogin" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "requirePasswordInviteCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "requireGithubInviteCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "requireLinuxDoInviteCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "registrationInviteCodeHash" TEXT,
ADD COLUMN "registrationInviteCodeEncrypted" TEXT;

-- AlterTable
ALTER TABLE "AuthOauthState" ADD COLUMN "registrationInviteGrantId" TEXT;

-- CreateTable
CREATE TABLE "RegistrationInviteGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "normalizedEmail" TEXT,
    "provider" "AuthProvider",
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RegistrationInviteGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInviteGrant_tokenHash_key" ON "RegistrationInviteGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "RegistrationInviteGrant_method_expiresAt_idx" ON "RegistrationInviteGrant"("method", "expiresAt");

-- CreateIndex
CREATE INDEX "RegistrationInviteGrant_normalizedEmail_method_expiresAt_idx" ON "RegistrationInviteGrant"("normalizedEmail", "method", "expiresAt");

-- CreateIndex
CREATE INDEX "RegistrationInviteGrant_provider_expiresAt_idx" ON "RegistrationInviteGrant"("provider", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthOauthState_registrationInviteGrantId_idx" ON "AuthOauthState"("registrationInviteGrantId");

-- AddForeignKey
ALTER TABLE "AuthOauthState" ADD CONSTRAINT "AuthOauthState_registrationInviteGrantId_fkey" FOREIGN KEY ("registrationInviteGrantId") REFERENCES "RegistrationInviteGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
