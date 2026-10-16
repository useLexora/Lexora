-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AiModelServiceScope" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "AiModelEndpointMode" AS ENUM ('FIXED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AiModelAuthMode" AS ENUM ('API_KEY', 'BEARER', 'NONE');

-- CreateEnum
CREATE TYPE "AiModelServiceVisibility" AS ENUM ('ALL_USERS');

-- CreateEnum
CREATE TYPE "AiModelType" AS ENUM ('CHAT', 'EMBEDDING', 'RERANK', 'IMAGE');

-- CreateEnum
CREATE TYPE "AiModelCapability" AS ENUM ('STREAMING', 'VISION', 'TOOL_CALL', 'REASONING', 'JSON_MODE');

-- CreateEnum
CREATE TYPE "AiAnchorKind" AS ENUM ('BLOCK_INSERT', 'TEXT_SELECTION');

-- CreateEnum
CREATE TYPE "AiSessionStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiCandidateStatus" AS ENUM ('COMPLETED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('GITHUB', 'LINUX_DO');

-- CreateEnum
CREATE TYPE "AuthEmailVerificationPurpose" AS ENUM ('REGISTER_VERIFY');

-- CreateEnum
CREATE TYPE "UserEmailVerificationPurpose" AS ENUM ('BIND_EMAIL');

-- CreateEnum
CREATE TYPE "AuthOauthPurpose" AS ENUM ('LOGIN', 'BIND');

-- CreateEnum
CREATE TYPE "ChatSessionMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'LOCKED');

-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('PRIVATE', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "DocumentAssetKind" AS ENUM ('IMAGE', 'FILE');

-- CreateEnum
CREATE TYPE "DocumentAssetStatus" AS ENUM ('PENDING', 'READY', 'DELETED');

-- CreateEnum
CREATE TYPE "DocumentShareMode" AS ENUM ('NONE', 'DIRECT_USER', 'LOGGED_IN', 'PUBLIC');

-- CreateEnum
CREATE TYPE "DocumentShareStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "DocumentSharePermission" AS ENUM ('VIEW', 'COMMENT');

-- CreateEnum
CREATE TYPE "DocumentShareRecipientStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'EXITED', 'REMOVED');

-- CreateEnum
CREATE TYPE "DocumentCollabRuntimeRole" AS ENUM ('EDITOR');

-- CreateEnum
CREATE TYPE "DocumentRecentVisitRouteKind" AS ENUM ('DOCUMENT', 'SHARE', 'SHARE_RECIPIENT');

-- CreateEnum
CREATE TYPE "SystemEmailProvider" AS ENUM ('TENCENT_EXMAIL', 'GOOGLE_WORKSPACE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "UserLanguagePreference" AS ENUM ('AUTO', 'ZH_CN', 'EN_US');

-- CreateEnum
CREATE TYPE "UserAppearancePreference" AS ENUM ('AUTO', 'LIGHT', 'DARK');

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'TEAM');

-- CreateEnum
CREATE TYPE "WorkspaceMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "WorkspaceMemberStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "WorkspaceInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED');

-- CreateTable
CREATE TABLE "AiModelServiceConfig" (
    "id" TEXT NOT NULL,
    "scope" "AiModelServiceScope" NOT NULL,
    "ownerUserId" TEXT,
    "providerKey" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "endpointMode" "AiModelEndpointMode" NOT NULL,
    "endpoint" TEXT,
    "authMode" "AiModelAuthMode" NOT NULL,
    "apiKeyEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "AiModelServiceVisibility" NOT NULL DEFAULT 'ALL_USERS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiModelServiceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelItem" (
    "id" TEXT NOT NULL,
    "serviceConfigId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelType" "AiModelType" NOT NULL,
    "capabilities" "AiModelCapability"[],
    "contextWindow" INTEGER,
    "maxOutputTokens" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiModelItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDefaultModelPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "serviceConfigId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiDefaultModelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSession" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "anchorKind" "AiAnchorKind" NOT NULL,
    "anchor" JSONB NOT NULL,
    "baseProjectionRevision" INTEGER NOT NULL,
    "status" "AiSessionStatus" NOT NULL DEFAULT 'PENDING',
    "currentRunId" TEXT,
    "acceptedCandidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "modelTargetSnapshot" JSONB,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCandidate" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "contentText" TEXT NOT NULL,
    "plainText" TEXT,
    "status" "AiCandidateStatus" NOT NULL DEFAULT 'COMPLETED',
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerUsername" TEXT,
    "providerEmail" TEXT,
    "providerEmailVerified" BOOLEAN,
    "rawProfile" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OauthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthOauthState" (
    "id" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "purpose" "AuthOauthPurpose" NOT NULL DEFAULT 'LOGIN',
    "initiatorUserId" TEXT,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AuthOauthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "replacedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AuthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthLoginCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AuthLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalCredential" (
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LocalCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AuthEmailVerificationToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AuthEmailVerificationPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AuthEmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmailVerificationCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "UserEmailVerificationPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UserEmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "historyVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSessionMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ChatSessionMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSessionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'PRIVATE',
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "currentProjectionId" TEXT,
    "currentProjectionRevision" INTEGER NOT NULL DEFAULT 0,
    "latestVersionSnapshotId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "trashedAt" TIMESTAMP(3),
    "trashedBy" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCurrentProjection" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectionRevision" INTEGER NOT NULL,
    "runtimeEpoch" INTEGER NOT NULL,
    "projectedUpdateSeq" INTEGER NOT NULL,
    "checkpointSeq" INTEGER NOT NULL,
    "checkpointUpdateSeq" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "title" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentCurrentProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersionSnapshot" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basedOnProjectionRevision" INTEGER NOT NULL,
    "runtimeEpoch" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "title" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "restoredFromVersionSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentVersionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentYdoc" (
    "documentId" TEXT NOT NULL,
    "ydocFormatVersion" INTEGER NOT NULL DEFAULT 1,
    "runtimeEpoch" INTEGER NOT NULL DEFAULT 1,
    "checkpointState" BYTEA,
    "checkpointSeq" INTEGER NOT NULL DEFAULT 0,
    "checkpointUpdateSeq" INTEGER NOT NULL DEFAULT 0,
    "updateSeq" INTEGER NOT NULL DEFAULT 0,
    "lastProjectedProjectionId" TEXT,
    "lastProjectedProjectionRevision" INTEGER NOT NULL DEFAULT 0,
    "lastProjectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentYdoc_pkey" PRIMARY KEY ("documentId")
);

-- CreateTable
CREATE TABLE "DocumentYdocUpdate" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "runtimeEpoch" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "clientId" TEXT,
    "update" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentYdocUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAsset" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" "DocumentAssetKind" NOT NULL,
    "status" "DocumentAssetStatus" NOT NULL DEFAULT 'READY',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentShare" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "mode" "DocumentShareMode" NOT NULL,
    "permission" "DocumentSharePermission" NOT NULL DEFAULT 'VIEW',
    "status" "DocumentShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentShareRecipient" (
    "id" TEXT NOT NULL,
    "documentShareId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "permission" "DocumentSharePermission" NOT NULL DEFAULT 'VIEW',
    "status" "DocumentShareRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentShareRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRecentVisit" (
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "routeKind" "DocumentRecentVisitRouteKind" NOT NULL,
    "routeEntryId" TEXT,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRecentVisit_pkey" PRIMARY KEY ("documentId","userId")
);

-- CreateTable
CREATE TABLE "DocumentCollabTicket" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "runtimeRole" "DocumentCollabRuntimeRole" NOT NULL,
    "canWrite" BOOLEAN NOT NULL,
    "runtimeEpoch" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentCollabTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "SystemAuthConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "allowPasswordRegistration" BOOLEAN NOT NULL DEFAULT true,
    "allowGithubRegistration" BOOLEAN NOT NULL DEFAULT true,
    "allowLinuxDoRegistration" BOOLEAN NOT NULL DEFAULT true,
    "systemAdminUserId" TEXT,
    "systemAdminEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SystemAuthConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemEmailConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "provider" "SystemEmailProvider" NOT NULL DEFAULT 'TENCENT_EXMAIL',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "smtpUsername" TEXT NOT NULL,
    "smtpPasswordEncrypted" TEXT,
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SystemEmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "avatarStorageKey" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "userId" TEXT NOT NULL,
    "languagePreference" "UserLanguagePreference" NOT NULL DEFAULT 'AUTO',
    "appearancePreference" "UserAppearancePreference" NOT NULL DEFAULT 'AUTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "type" "WorkspaceType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT NOT NULL,
    "iconUrl" TEXT,
    "iconStorageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceMemberRole" NOT NULL,
    "status" "WorkspaceMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "status" "WorkspaceInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModelServiceConfig_scope_enabled_idx" ON "AiModelServiceConfig"("scope", "enabled");

-- CreateIndex
CREATE INDEX "AiModelServiceConfig_ownerUserId_enabled_idx" ON "AiModelServiceConfig"("ownerUserId", "enabled");

-- CreateIndex
CREATE INDEX "AiModelServiceConfig_providerKey_idx" ON "AiModelServiceConfig"("providerKey");

-- CreateIndex
CREATE INDEX "AiModelServiceConfig_updatedBy_idx" ON "AiModelServiceConfig"("updatedBy");

-- CreateIndex
CREATE INDEX "AiModelItem_serviceConfigId_enabled_idx" ON "AiModelItem"("serviceConfigId", "enabled");

-- CreateIndex
CREATE INDEX "AiModelItem_modelType_idx" ON "AiModelItem"("modelType");

-- CreateIndex
CREATE INDEX "AiModelItem_updatedBy_idx" ON "AiModelItem"("updatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelItem_serviceConfigId_modelId_key" ON "AiModelItem"("serviceConfigId", "modelId");

-- CreateIndex
CREATE INDEX "AiDefaultModelPolicy_serviceConfigId_idx" ON "AiDefaultModelPolicy"("serviceConfigId");

-- CreateIndex
CREATE INDEX "AiDefaultModelPolicy_updatedBy_idx" ON "AiDefaultModelPolicy"("updatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "AiDefaultModelPolicy_userId_intentKey_key" ON "AiDefaultModelPolicy"("userId", "intentKey");

-- CreateIndex
CREATE INDEX "AiSession_documentId_createdAt_idx" ON "AiSession"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSession_createdBy_createdAt_idx" ON "AiSession"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "AiSession_status_idx" ON "AiSession"("status");

-- CreateIndex
CREATE INDEX "AiSession_currentRunId_idx" ON "AiSession"("currentRunId");

-- CreateIndex
CREATE INDEX "AiSession_acceptedCandidateId_idx" ON "AiSession"("acceptedCandidateId");

-- CreateIndex
CREATE INDEX "AiSession_updatedBy_idx" ON "AiSession"("updatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_agentRunId_key" ON "AiRun"("agentRunId");

-- CreateIndex
CREATE INDEX "AiRun_sessionId_createdAt_idx" ON "AiRun"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_workflowKey_status_idx" ON "AiRun"("workflowKey", "status");

-- CreateIndex
CREATE INDEX "AiRun_createdBy_createdAt_idx" ON "AiRun"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_updatedBy_idx" ON "AiRun"("updatedBy");

-- CreateIndex
CREATE INDEX "AiCandidate_sessionId_createdAt_idx" ON "AiCandidate"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCandidate_runId_idx" ON "AiCandidate"("runId");

-- CreateIndex
CREATE INDEX "AiCandidate_status_idx" ON "AiCandidate"("status");

-- CreateIndex
CREATE INDEX "AiCandidate_createdBy_createdAt_idx" ON "AiCandidate"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "AiCandidate_updatedBy_idx" ON "AiCandidate"("updatedBy");

-- CreateIndex
CREATE INDEX "OauthAccount_userId_idx" ON "OauthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthAccount_provider_providerUserId_key" ON "OauthAccount"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthOauthState_state_key" ON "AuthOauthState"("state");

-- CreateIndex
CREATE INDEX "AuthOauthState_provider_expiresAt_idx" ON "AuthOauthState"("provider", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthOauthState_initiatorUserId_purpose_idx" ON "AuthOauthState"("initiatorUserId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "AuthRefreshToken_tokenHash_key" ON "AuthRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthRefreshToken_userId_idx" ON "AuthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "AuthRefreshToken_familyId_idx" ON "AuthRefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "AuthRefreshToken_expiresAt_idx" ON "AuthRefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthLoginCode_codeHash_key" ON "AuthLoginCode"("codeHash");

-- CreateIndex
CREATE INDEX "AuthLoginCode_userId_expiresAt_idx" ON "AuthLoginCode"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthEmailVerificationToken_tokenHash_key" ON "AuthEmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthEmailVerificationToken_email_purpose_expiresAt_idx" ON "AuthEmailVerificationToken"("email", "purpose", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmailVerificationCode_codeHash_key" ON "UserEmailVerificationCode"("codeHash");

-- CreateIndex
CREATE INDEX "UserEmailVerificationCode_userId_purpose_expiresAt_idx" ON "UserEmailVerificationCode"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "UserEmailVerificationCode_email_purpose_expiresAt_idx" ON "UserEmailVerificationCode"("email", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "ChatSession_userId_updatedAt_idx" ON "ChatSession"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_sessionId_createdAt_idx" ON "ChatSessionMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionMessage_sessionId_order_key" ON "ChatSessionMessage"("sessionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Document_currentProjectionId_key" ON "Document"("currentProjectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_latestVersionSnapshotId_key" ON "Document"("latestVersionSnapshotId");

-- CreateIndex
CREATE INDEX "Document_workspaceId_idx" ON "Document"("workspaceId");

-- CreateIndex
CREATE INDEX "Document_workspaceId_parentId_order_idx" ON "Document"("workspaceId", "parentId", "order");

-- CreateIndex
CREATE INDEX "Document_workspaceId_visibility_parentId_order_idx" ON "Document"("workspaceId", "visibility", "parentId", "order");

-- CreateIndex
CREATE INDEX "Document_workspaceId_status_idx" ON "Document"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Document_workspaceId_trashedAt_idx" ON "Document"("workspaceId", "trashedAt");

-- CreateIndex
CREATE INDEX "Document_createdBy_workspaceId_visibility_idx" ON "Document"("createdBy", "workspaceId", "visibility");

-- CreateIndex
CREATE INDEX "DocumentCurrentProjection_documentId_updatedAt_idx" ON "DocumentCurrentProjection"("documentId", "updatedAt");

-- CreateIndex
CREATE INDEX "DocumentCurrentProjection_documentId_runtimeEpoch_projected_idx" ON "DocumentCurrentProjection"("documentId", "runtimeEpoch", "projectedUpdateSeq");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCurrentProjection_documentId_projectionRevision_key" ON "DocumentCurrentProjection"("documentId", "projectionRevision");

-- CreateIndex
CREATE INDEX "DocumentVersionSnapshot_documentId_createdAt_idx" ON "DocumentVersionSnapshot"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentVersionSnapshot_documentId_basedOnProjectionRevisio_idx" ON "DocumentVersionSnapshot"("documentId", "basedOnProjectionRevision");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersionSnapshot_documentId_version_key" ON "DocumentVersionSnapshot"("documentId", "version");

-- CreateIndex
CREATE INDEX "DocumentYdoc_runtimeEpoch_idx" ON "DocumentYdoc"("runtimeEpoch");

-- CreateIndex
CREATE INDEX "DocumentYdoc_lastProjectedProjectionId_idx" ON "DocumentYdoc"("lastProjectedProjectionId");

-- CreateIndex
CREATE INDEX "DocumentYdocUpdate_documentId_runtimeEpoch_createdAt_idx" ON "DocumentYdocUpdate"("documentId", "runtimeEpoch", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentYdocUpdate_documentId_runtimeEpoch_seq_key" ON "DocumentYdocUpdate"("documentId", "runtimeEpoch", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentYdocUpdate_documentId_runtimeEpoch_idempotencyKey_key" ON "DocumentYdocUpdate"("documentId", "runtimeEpoch", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DocumentAsset_documentId_createdAt_idx" ON "DocumentAsset"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentAsset_documentId_kind_status_idx" ON "DocumentAsset"("documentId", "kind", "status");

-- CreateIndex
CREATE INDEX "DocumentAsset_sha256_idx" ON "DocumentAsset"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAsset_bucket_objectKey_key" ON "DocumentAsset"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "DocumentShare_documentId_status_mode_idx" ON "DocumentShare"("documentId", "status", "mode");

-- CreateIndex
CREATE INDEX "DocumentShare_documentId_status_updatedAt_idx" ON "DocumentShare"("documentId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DocumentShareRecipient_recipientUserId_status_updatedAt_idx" ON "DocumentShareRecipient"("recipientUserId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentShareRecipient_documentShareId_recipientUserId_key" ON "DocumentShareRecipient"("documentShareId", "recipientUserId");

-- CreateIndex
CREATE INDEX "DocumentRecentVisit_userId_visitedAt_idx" ON "DocumentRecentVisit"("userId", "visitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCollabTicket_tokenHash_key" ON "DocumentCollabTicket"("tokenHash");

-- CreateIndex
CREATE INDEX "DocumentCollabTicket_documentId_expiresAt_idx" ON "DocumentCollabTicket"("documentId", "expiresAt");

-- CreateIndex
CREATE INDEX "DocumentCollabTicket_userId_expiresAt_idx" ON "DocumentCollabTicket"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemAuthConfig_systemAdminUserId_key" ON "SystemAuthConfig"("systemAdminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemAuthConfig_systemAdminEmail_key" ON "SystemAuthConfig"("systemAdminEmail");

-- CreateIndex
CREATE INDEX "SystemAuthConfig_updatedBy_idx" ON "SystemAuthConfig"("updatedBy");

-- CreateIndex
CREATE INDEX "SystemEmailConfig_updatedBy_idx" ON "SystemEmailConfig"("updatedBy");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_userCode_key" ON "User"("userCode");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Workspace_type_createdAt_idx" ON "Workspace"("type", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_status_idx" ON "WorkspaceMember"("userId", "status");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_status_role_idx" ON "WorkspaceMember"("workspaceId", "status", "role");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_workspaceId_status_updatedAt_idx" ON "WorkspaceInvite"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_inviteeUserId_status_updatedAt_idx" ON "WorkspaceInvite"("inviteeUserId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "AiModelServiceConfig" ADD CONSTRAINT "AiModelServiceConfig_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelServiceConfig" ADD CONSTRAINT "AiModelServiceConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelItem" ADD CONSTRAINT "AiModelItem_serviceConfigId_fkey" FOREIGN KEY ("serviceConfigId") REFERENCES "AiModelServiceConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelItem" ADD CONSTRAINT "AiModelItem_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDefaultModelPolicy" ADD CONSTRAINT "AiDefaultModelPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDefaultModelPolicy" ADD CONSTRAINT "AiDefaultModelPolicy_serviceConfigId_fkey" FOREIGN KEY ("serviceConfigId") REFERENCES "AiModelServiceConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDefaultModelPolicy" ADD CONSTRAINT "AiDefaultModelPolicy_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_currentRunId_fkey" FOREIGN KEY ("currentRunId") REFERENCES "AiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_acceptedCandidateId_fkey" FOREIGN KEY ("acceptedCandidateId") REFERENCES "AiCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSession" ADD CONSTRAINT "AiSession_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthAccount" ADD CONSTRAINT "OauthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthOauthState" ADD CONSTRAINT "AuthOauthState_initiatorUserId_fkey" FOREIGN KEY ("initiatorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthRefreshToken" ADD CONSTRAINT "AuthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthRefreshToken" ADD CONSTRAINT "AuthRefreshToken_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "AuthRefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthLoginCode" ADD CONSTRAINT "AuthLoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalCredential" ADD CONSTRAINT "LocalCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmailVerificationCode" ADD CONSTRAINT "UserEmailVerificationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionMessage" ADD CONSTRAINT "ChatSessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentProjectionId_fkey" FOREIGN KEY ("currentProjectionId") REFERENCES "DocumentCurrentProjection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_latestVersionSnapshotId_fkey" FOREIGN KEY ("latestVersionSnapshotId") REFERENCES "DocumentVersionSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_trashedBy_fkey" FOREIGN KEY ("trashedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCurrentProjection" ADD CONSTRAINT "DocumentCurrentProjection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersionSnapshot" ADD CONSTRAINT "DocumentVersionSnapshot_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersionSnapshot" ADD CONSTRAINT "DocumentVersionSnapshot_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentYdoc" ADD CONSTRAINT "DocumentYdoc_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentYdoc" ADD CONSTRAINT "DocumentYdoc_lastProjectedProjectionId_fkey" FOREIGN KEY ("lastProjectedProjectionId") REFERENCES "DocumentCurrentProjection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentYdocUpdate" ADD CONSTRAINT "DocumentYdocUpdate_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentYdoc"("documentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentYdocUpdate" ADD CONSTRAINT "DocumentYdocUpdate_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShare" ADD CONSTRAINT "DocumentShare_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShare" ADD CONSTRAINT "DocumentShare_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShare" ADD CONSTRAINT "DocumentShare_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShareRecipient" ADD CONSTRAINT "DocumentShareRecipient_documentShareId_fkey" FOREIGN KEY ("documentShareId") REFERENCES "DocumentShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShareRecipient" ADD CONSTRAINT "DocumentShareRecipient_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShareRecipient" ADD CONSTRAINT "DocumentShareRecipient_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentShareRecipient" ADD CONSTRAINT "DocumentShareRecipient_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRecentVisit" ADD CONSTRAINT "DocumentRecentVisit_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRecentVisit" ADD CONSTRAINT "DocumentRecentVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollabTicket" ADD CONSTRAINT "DocumentCollabTicket_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCollabTicket" ADD CONSTRAINT "DocumentCollabTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemAuthConfig" ADD CONSTRAINT "SystemAuthConfig_systemAdminUserId_fkey" FOREIGN KEY ("systemAdminUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemAuthConfig" ADD CONSTRAINT "SystemAuthConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemEmailConfig" ADD CONSTRAINT "SystemEmailConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
