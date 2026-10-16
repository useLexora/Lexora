import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { SystemEmailModule } from '../system-email/system-email.module'
import { CapabilitiesController } from './capabilities.controller'
import { CapabilitiesService } from './capabilities.service'

@Module({
  imports: [AuthModule, SystemEmailModule],
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService],
})
export class CapabilitiesModule {}
