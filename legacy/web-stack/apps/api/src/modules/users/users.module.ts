import { Module } from '@nestjs/common'
import { StorageModule } from '../../infrastructure/storage/storage.module'
import { AuthModule } from '../auth/auth.module'
import { RbacModule } from '../rbac/rbac.module'
import { SystemEmailModule } from '../system-email/system-email.module'
import { UserAvatarsService } from './user-avatars.service'
import { UserEmailBindingsService } from './user-email-bindings.service'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

@Module({
  imports: [RbacModule, AuthModule, StorageModule, SystemEmailModule],
  controllers: [UsersController],
  providers: [UsersService, UserAvatarsService, UserEmailBindingsService],
})
export class UsersModule {}
