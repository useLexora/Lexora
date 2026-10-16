import { Module } from '@nestjs/common'
import { StorageService } from './storage.service'

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
