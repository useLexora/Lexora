CREATE TABLE "AgentSkillCredential" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "credentialEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentSkillCredential_ownerUserId_skillKey_key" ON "AgentSkillCredential"("ownerUserId", "skillKey");

CREATE INDEX "AgentSkillCredential_skillKey_idx" ON "AgentSkillCredential"("skillKey");

ALTER TABLE "AgentSkillCredential" ADD CONSTRAINT "AgentSkillCredential_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
