import type { AgentRuntimeHints } from '@haohaoxue/lexora-contracts'
import type { FastifyRequest } from 'fastify'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  createRuntimeHintsWithLocationClientIp,
  readTrustedClientIp,
} from './chat-location-runtime.utils'

@Injectable()
export class ChatLocationResolverService {
  private readonly trustCloudflareIpHeaders: boolean

  constructor(configService: ConfigService) {
    this.trustCloudflareIpHeaders = configService.getOrThrow<boolean>('server.trustCloudflareIpHeaders')
  }

  resolveRuntimeHints(input: {
    request: Pick<FastifyRequest, 'headers' | 'ip'>
    runtimeHints?: AgentRuntimeHints | null
  }): AgentRuntimeHints {
    const clientIp = readTrustedClientIp({
      headers: input.request.headers,
      remoteAddress: input.request.ip,
      trustCloudflareHeaders: this.trustCloudflareIpHeaders,
    })

    return createRuntimeHintsWithLocationClientIp({
      runtimeHints: input.runtimeHints,
      clientIp,
    })
  }
}
