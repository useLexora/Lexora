import type { OnModuleDestroy } from '@nestjs/common'
import type { RedisConfig } from '../../config/redis.config'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null

  constructor(private readonly configService: ConfigService) {}

  getClient(): Redis {
    if (this.client) {
      return this.client
    }

    this.client = this.createClient()

    return this.client
  }

  createClient(): Redis {
    const config = this.configService.getOrThrow<RedisConfig>('redis')
    return new Redis(config.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
  }

  createBullMqClient(): Redis {
    const config = this.configService.getOrThrow<RedisConfig>('redis')
    return new Redis(config.url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    })
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) {
      return
    }

    try {
      await this.client.quit()
    }
    catch {
      this.client.disconnect()
    }
    finally {
      this.client = null
    }
  }
}
