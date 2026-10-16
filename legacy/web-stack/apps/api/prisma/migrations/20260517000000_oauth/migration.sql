ALTER TYPE "AuthProvider" ADD VALUE 'GOOGLE';

ALTER TABLE "SystemAuthConfig" ADD COLUMN "oauthProviderOptions" JSONB NOT NULL DEFAULT '{}';

UPDATE "SystemAuthConfig"
SET "oauthProviderOptions" = jsonb_build_object(
  'github', jsonb_build_object(
    'allowLogin', "allowGithubLogin",
    'allowRegistration', "allowGithubRegistration",
    'requireInviteCode', "requireGithubInviteCode"
  ),
  'linux-do', jsonb_build_object(
    'allowLogin', "allowLinuxDoLogin",
    'allowRegistration', "allowLinuxDoRegistration",
    'requireInviteCode', "requireLinuxDoInviteCode"
  ),
  'google', jsonb_build_object(
    'allowLogin', true,
    'allowRegistration', true,
    'requireInviteCode', false
  )
);

ALTER TABLE "SystemAuthConfig"
DROP COLUMN "allowGithubLogin",
DROP COLUMN "allowLinuxDoLogin",
DROP COLUMN "allowGithubRegistration",
DROP COLUMN "allowLinuxDoRegistration",
DROP COLUMN "requireGithubInviteCode",
DROP COLUMN "requireLinuxDoInviteCode";
