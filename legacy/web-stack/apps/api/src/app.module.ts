import { randomUUID } from 'node:crypto'
import { Module, RequestMethod } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { AppConfigModule } from './config/app-config.module'
import { PrismaModule } from './database/prisma.module'
import { AccessTokenGuard } from './guards/access-token.guard'
import { AppInternalKeyGuard } from './guards/app-internal-key.guard'
import { PermissionsGuard } from './guards/permissions.guard'
import { AiModule } from './modules/ai/ai.module'
import { AuthModule } from './modules/auth/auth.module'
import { BotsModule } from './modules/bots/bots.module'
import { CapabilitiesModule } from './modules/capabilities/capabilities.module'
import { ChatModule } from './modules/chat/chat.module'
import { DocumentsModule } from './modules/documents/documents.module'
import { HealthModule } from './modules/health/health.module'
import { NotificationsModule } from './modules/notifications/notifications.module'
import { RbacModule } from './modules/rbac/rbac.module'
import { SystemAdminModule } from './modules/system-admin/system-admin.module'
import { UsersModule } from './modules/users/users.module'
import { WorkspacesModule } from './modules/workspaces/workspaces.module'

@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const level = configService.getOrThrow<string>('logger.level')
        const pretty = configService.getOrThrow<boolean>('logger.pretty')

        return {
          forRoutes: [{ path: '*path', method: RequestMethod.ALL }],
          pinoHttp: {
            level,
            genReqId: (req, res) => {
              const header = req.headers['x-request-id']
              const requestId = Array.isArray(header) ? header[0] : header
              const value = requestId?.trim() ? requestId : randomUUID()
              res.setHeader('x-request-id', value)
              return value
            },
            autoLogging: {
              ignore: req => req.url?.startsWith('/health') ?? false,
            },
            customLogLevel: (_req, res, error) => {
              if (error || res.statusCode >= 500) {
                return 'error'
              }
              if (res.statusCode >= 400) {
                return 'warn'
              }
              return 'info'
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["set-cookie"]',
                'req.headers["x-api-key"]',
                'req.headers["x-app-internal-key"]',
                'req.body.provider.apiKey',
                'req.body.apiKey',
              ],
              censor: '[Redacted]',
            },
            transport: pretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                    ignore: 'pid,hostname,req.headers,res.headers,responseTime',
                  },
                }
              : undefined,
          },
        }
      },
    }),
    PrismaModule,
    RbacModule,
    AuthModule,
    AiModule,
    BotsModule,
    CapabilitiesModule,
    ChatModule,
    NotificationsModule,
    UsersModule,
    WorkspacesModule,
    SystemAdminModule,
    HealthModule,
    DocumentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AppInternalKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AccessTokenGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}
