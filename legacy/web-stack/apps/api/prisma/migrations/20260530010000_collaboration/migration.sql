CREATE TYPE "DocumentCollaborationPermission" AS ENUM ('READ', 'EDIT');
CREATE TYPE "DocumentCollaborationScope" AS ENUM ('SELF', 'DESCENDANTS');
CREATE TYPE "DocumentCollaborationGrantSourceType" AS ENUM ('USER_INVITE', 'LINK_INVITE', 'MANUAL');
CREATE TYPE "DocumentCollaborationGrantStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "DocumentCollaborationUserInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED');
CREATE TYPE "CollaborationResolverEntryType" AS ENUM ('DOCUMENT_USER_INVITE', 'DOCUMENT_LINK_INVITE');
CREATE TYPE "CollaborationResolverEntryStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "DocumentPublicationStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "DocumentPublicationTheme" AS ENUM ('DEFAULT');

CREATE TABLE "DocumentCollaborationGrant" (
    "id" TEXT NOT NULL,
    "rootDocumentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" "DocumentCollaborationPermission" NOT NULL,
    "scope" "DocumentCollaborationScope" NOT NULL,
    "sourceType" "DocumentCollaborationGrantSourceType" NOT NULL,
    "sourceId" TEXT,
    "status" "DocumentCollaborationGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentCollaborationGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentCollaborationUserInvite" (
    "id" TEXT NOT NULL,
    "rootDocumentId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "permission" "DocumentCollaborationPermission" NOT NULL,
    "scope" "DocumentCollaborationScope" NOT NULL,
    "status" "DocumentCollaborationUserInviteStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedGrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentCollaborationUserInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentCollaborationLinkInvite" (
    "id" TEXT NOT NULL,
    "rootDocumentId" TEXT NOT NULL,
    "permission" "DocumentCollaborationPermission" NOT NULL,
    "scope" "DocumentCollaborationScope" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentCollaborationLinkInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollaborationResolverEntry" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "CollaborationResolverEntryType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" "CollaborationResolverEntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaborationResolverEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublication" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "icon" TEXT,
    "theme" "DocumentPublicationTheme" NOT NULL DEFAULT 'DEFAULT',
    "scope" "DocumentCollaborationScope" NOT NULL,
    "navConfig" JSONB,
    "sidebarConfig" JSONB,
    "status" "DocumentPublicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentPublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentCollaborationGrant_rootDocumentId_userId_key" ON "DocumentCollaborationGrant"("rootDocumentId", "userId");
CREATE INDEX "DocumentCollaborationGrant_userId_status_updatedAt_idx" ON "DocumentCollaborationGrant"("userId", "status", "updatedAt");
CREATE INDEX "DocumentCollaborationGrant_rootDocumentId_status_idx" ON "DocumentCollaborationGrant"("rootDocumentId", "status");
CREATE INDEX "DocumentCollaborationGrant_sourceType_sourceId_idx" ON "DocumentCollaborationGrant"("sourceType", "sourceId");
CREATE UNIQUE INDEX "DocumentCollaborationUserInvite_acceptedGrantId_key" ON "DocumentCollaborationUserInvite"("acceptedGrantId");
CREATE UNIQUE INDEX "DocumentCollaborationUserInvite_rootDocumentId_inviteeUserId_key" ON "DocumentCollaborationUserInvite"("rootDocumentId", "inviteeUserId");
CREATE INDEX "DocumentCollaborationUserInvite_inviteeUserId_status_updatedAt_idx" ON "DocumentCollaborationUserInvite"("inviteeUserId", "status", "updatedAt");
CREATE INDEX "DocumentCollaborationUserInvite_rootDocumentId_status_idx" ON "DocumentCollaborationUserInvite"("rootDocumentId", "status");
CREATE UNIQUE INDEX "DocumentCollaborationLinkInvite_rootDocumentId_key" ON "DocumentCollaborationLinkInvite"("rootDocumentId");
CREATE INDEX "DocumentCollaborationLinkInvite_rootDocumentId_enabled_idx" ON "DocumentCollaborationLinkInvite"("rootDocumentId", "enabled");
CREATE UNIQUE INDEX "CollaborationResolverEntry_code_key" ON "CollaborationResolverEntry"("code");
CREATE INDEX "CollaborationResolverEntry_type_targetId_status_idx" ON "CollaborationResolverEntry"("type", "targetId", "status");
CREATE INDEX "CollaborationResolverEntry_status_updatedAt_idx" ON "CollaborationResolverEntry"("status", "updatedAt");
CREATE UNIQUE INDEX "DocumentPublication_documentId_key" ON "DocumentPublication"("documentId");
CREATE UNIQUE INDEX "DocumentPublication_slug_key" ON "DocumentPublication"("slug");
CREATE INDEX "DocumentPublication_documentId_status_idx" ON "DocumentPublication"("documentId", "status");
CREATE INDEX "DocumentPublication_status_updatedAt_idx" ON "DocumentPublication"("status", "updatedAt");

ALTER TABLE "DocumentCollaborationGrant" ADD CONSTRAINT "DocumentCollaborationGrant_rootDocumentId_fkey" FOREIGN KEY ("rootDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationGrant" ADD CONSTRAINT "DocumentCollaborationGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationGrant" ADD CONSTRAINT "DocumentCollaborationGrant_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationGrant" ADD CONSTRAINT "DocumentCollaborationGrant_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationUserInvite" ADD CONSTRAINT "DocumentCollaborationUserInvite_rootDocumentId_fkey" FOREIGN KEY ("rootDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationUserInvite" ADD CONSTRAINT "DocumentCollaborationUserInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationUserInvite" ADD CONSTRAINT "DocumentCollaborationUserInvite_acceptedGrantId_fkey" FOREIGN KEY ("acceptedGrantId") REFERENCES "DocumentCollaborationGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationUserInvite" ADD CONSTRAINT "DocumentCollaborationUserInvite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationUserInvite" ADD CONSTRAINT "DocumentCollaborationUserInvite_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationLinkInvite" ADD CONSTRAINT "DocumentCollaborationLinkInvite_rootDocumentId_fkey" FOREIGN KEY ("rootDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationLinkInvite" ADD CONSTRAINT "DocumentCollaborationLinkInvite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentCollaborationLinkInvite" ADD CONSTRAINT "DocumentCollaborationLinkInvite_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublication" ADD CONSTRAINT "DocumentPublication_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublication" ADD CONSTRAINT "DocumentPublication_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublication" ADD CONSTRAINT "DocumentPublication_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE IF EXISTS "DocumentShareRecipient";
DROP TABLE IF EXISTS "DocumentShare";
DROP TYPE IF EXISTS "DocumentShareRecipientStatus";
DROP TYPE IF EXISTS "DocumentSharePermission";
DROP TYPE IF EXISTS "DocumentShareStatus";
DROP TYPE IF EXISTS "DocumentShareMode";
