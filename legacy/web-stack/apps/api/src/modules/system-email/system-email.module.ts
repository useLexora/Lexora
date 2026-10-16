import { Module } from '@nestjs/common'
import { SystemEmailService } from './system-email.service'

@Module({
  providers: [SystemEmailService],
  exports: [SystemEmailService],
})
export class SystemEmailModule {}
