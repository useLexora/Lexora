import { Module } from '@nestjs/common'
import { RbacService } from './rbac.service'

@Module({
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
