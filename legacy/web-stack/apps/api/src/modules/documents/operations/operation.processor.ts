import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type Redis from 'ioredis'
import type { DocumentOperationQueuePayload } from './operation-queue.service'
import { Injectable, Logger } from '@nestjs/common'
import { Worker } from 'bullmq'
import { RedisService } from '../../../infrastructure/redis/redis.service'
import { DOCUMENT_OPERATION_QUEUE_NAME } from './operations.constants'
import { DocumentOperationsService } from './operations.service'

@Injectable()
export class DocumentOperationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentOperationProcessor.name)
  private worker: Worker<DocumentOperationQueuePayload> | null = null
  private connection: Redis | null = null

  constructor(
    private readonly redisService: RedisService,
    private readonly documentOperationsService: DocumentOperationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const interruptedJobs = await this.documentOperationsService.failInterruptedRunningJobs()
    if (interruptedJobs > 0) {
      this.logger.warn(`已将 ${interruptedJobs} 个中断的文档任务标记为失败`)
    }

    this.connection = this.redisService.createBullMqClient()
    this.worker = new Worker<DocumentOperationQueuePayload>(
      DOCUMENT_OPERATION_QUEUE_NAME,
      async (job) => {
        await this.documentOperationsService.runOperationJob(job.data.jobId)
      },
      {
        connection: this.connection,
        concurrency: 1,
      },
    )
    this.worker.on('failed', (job, error) => {
      this.logger.warn(`文档任务队列执行失败: ${job?.data.jobId ?? 'unknown'} ${error.message}`)
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close()
    this.worker = null

    if (!this.connection) {
      return
    }

    try {
      await this.connection.quit()
    }
    catch {
      this.connection.disconnect()
    }
    finally {
      this.connection = null
    }
  }
}
