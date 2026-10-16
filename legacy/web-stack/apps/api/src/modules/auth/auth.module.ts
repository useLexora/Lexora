import { Module } from '@nestjs/common'
import { StorageModule } from '../../infrastructure/storage/storage.module'
import { RbacModule } from '../rbac/rbac.module'
import { SystemEmailModule } from '../system-email/system-email.module'
import { WorkspacesModule } from '../workspaces/workspaces.module'
import { AuthMailerService } from './auth-mailer.service'
import { AuthRegistrationsService } from './auth-registrations.service'
import { AuthSessionsService } from './auth-sessions.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { OAuthProviderService } from './providers/oauth-provider.service'
import { RegistrationInviteGrantsService } from './registration-invite-grants.service'
import { SystemAuthService } from './system-auth.service'

@Module({
  imports: [RbacModule, StorageModule, SystemEmailModule, WorkspacesModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRegistrationsService, AuthSessionsService, AuthMailerService, OAuthProviderService, RegistrationInviteGrantsService, SystemAuthService],
  exports: [AuthMailerService, AuthService, AuthSessionsService, RegistrationInviteGrantsService, SystemAuthService],
})
export class AuthModule {}
