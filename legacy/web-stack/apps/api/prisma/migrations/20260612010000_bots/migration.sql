CREATE TYPE "ChatSessionChannel" AS ENUM ('DIRECT', 'WEIXIN_BOT');

ALTER TABLE "ChatSession"
ADD COLUMN "channel" "ChatSessionChannel" NOT NULL DEFAULT 'DIRECT';

CREATE INDEX "ChatSession_workspaceId_origin_channel_updatedAt_idx" ON "ChatSession"("workspaceId", "origin", "channel", "updatedAt");

CREATE TYPE "BotAccountChannel" AS ENUM ('WEIXIN');

CREATE TYPE "BotAccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

CREATE TABLE "BotAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" "BotAccountChannel" NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "externalUserId" TEXT,
  "displayName" TEXT,
  "credentialEncrypted" TEXT NOT NULL,
  "getUpdatesCursor" TEXT NOT NULL DEFAULT '',
  "status" "BotAccountStatus" NOT NULL DEFAULT 'CONNECTED',
  "lastError" TEXT,
  "lastStartedAt" TIMESTAMP(3),
  "lastStoppedAt" TIMESTAMP(3),
  "lastInboundAt" TIMESTAMP(3),
  "lastOutboundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotConversation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "peerExternalId" TEXT NOT NULL,
  "peerDisplayName" TEXT,
  "chatSessionId" TEXT NOT NULL,
  "contextToken" TEXT,
  "lastInboundAt" TIMESTAMP(3),
  "lastOutboundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotMessageReceipt" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "messageKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotMessageReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotAccount_userId_channel_externalAccountId_key" ON "BotAccount"("userId", "channel", "externalAccountId");
CREATE INDEX "BotAccount_userId_channel_updatedAt_idx" ON "BotAccount"("userId", "channel", "updatedAt");
CREATE INDEX "BotAccount_channel_status_updatedAt_idx" ON "BotAccount"("channel", "status", "updatedAt");

CREATE UNIQUE INDEX "BotConversation_chatSessionId_key" ON "BotConversation"("chatSessionId");
CREATE UNIQUE INDEX "BotConversation_accountId_peerExternalId_key" ON "BotConversation"("accountId", "peerExternalId");
CREATE INDEX "BotConversation_accountId_updatedAt_idx" ON "BotConversation"("accountId", "updatedAt");

CREATE UNIQUE INDEX "BotMessageReceipt_accountId_messageKey_key" ON "BotMessageReceipt"("accountId", "messageKey");
CREATE INDEX "BotMessageReceipt_accountId_createdAt_idx" ON "BotMessageReceipt"("accountId", "createdAt");

ALTER TABLE "BotAccount"
ADD CONSTRAINT "BotAccount_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotConversation"
ADD CONSTRAINT "BotConversation_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "BotAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotConversation"
ADD CONSTRAINT "BotConversation_chatSessionId_fkey"
FOREIGN KEY ("chatSessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotMessageReceipt"
ADD CONSTRAINT "BotMessageReceipt_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "BotAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
