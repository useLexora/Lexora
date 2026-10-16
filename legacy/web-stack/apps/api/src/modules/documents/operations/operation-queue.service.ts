import type { OnModuleDestroy } from '@nestjs/common'
import type Redis from 'ioredis'
import { Injectable } from '@nestjs/common'
import { Queue } from 'bullmq'
import { RedisService } from '../../../infrastructure/redis/redis.service'
import {
  DOCUMENT_OPERATION_QUEUE_JOB_NAME,
  DOCUMENT_OPERATION_QUEUE_NAME,
} from './operations.constants'

export interface DocumentOperationQueuePayload {
  jobId: string
}

@Injectable()
export class DocumentOperationQueueService implements OnModuleDestroy {
  private queue: Queue<DocumentOperationQueuePayload> | null = null
  private connection: Redis | null = null

  constructor(private readonly redisService: RedisService) {}

  async enqueue(jobId: string): Promise<void> {
    await this.getQueue().add(
      DOCUMENT_OPERATION_QUEUE_JOB_NAME,
      { jobId },
      {
        jobId,
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    )
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close()
    this.queue = null

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

  private getQueue(): Queue<DocumentOperationQueuePayload> {
    if (this.queue) {
      return this.queue
    }

    this.connection = this.redisService.createBullMqClient()
    this.queue = new Queue<DocumentOperationQueuePayload>(DOCUMENT_OPERATION_QUEUE_NAME, {
      connection: this.connection,
    })

    return this.queue
  }
}
