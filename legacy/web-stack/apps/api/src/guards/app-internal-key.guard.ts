import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { APP_INTERNAL_KEY_HEADER } from '@haohaoxue/lexora-contracts'
import { isMatchingAppInternalKey, readAppInternalKeyHeader } from '@haohaoxue/lexora-shared'
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class AppInternalKeyGuard implements CanActivate {
  private readonly appInternalKey: string

  constructor(configService: ConfigService) {
    this.appInternalKey = configService.getOrThrow<string>('APP_INTERNAL_KEY')
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      url?: string
      headers: Record<string, string | string[] | undefined>
    }>()

    if (!isInternalRouteUrl(request.url)) {
      return true
    }

    const receivedKey = readAppInternalKeyHeader(request.headers[APP_INTERNAL_KEY_HEADER])

    if (isMatchingAppInternalKey(this.appInternalKey, receivedKey)) {
      return true
    }

    throw new UnauthorizedException('Invalid app internal key')
  }
}

function isInternalRouteUrl(url: string | undefined): boolean {
  if (!url) {
    return false
  }

  const pathname = new URL(url, 'http://lexora.local').pathname

  return pathname === '/internal' || pathname.startsWith('/internal/')
}
