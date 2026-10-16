DROP INDEX "BotAccount_userId_channel_externalAccountId_key";

CREATE UNIQUE INDEX "BotAccount_userId_channel_key" ON "BotAccount"("userId", "channel");
CREATE UNIQUE INDEX "BotAccount_channel_externalAccountId_key" ON "BotAccount"("channel", "externalAccountId");
