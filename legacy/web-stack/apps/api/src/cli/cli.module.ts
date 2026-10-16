import { Module } from '@nestjs/common'
import { AppConfigModule } from '../config/app-config.module'
import { PrismaModule } from '../database/prisma.module'

@Module({
  imports: [AppConfigModule, PrismaModule],
})
export class CliModule {}
