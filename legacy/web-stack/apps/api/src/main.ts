import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import process from 'node:process'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { Logger as AppLogger, RequestMethod, ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino'
import { AppModule } from './app.module'
import { GlobalExceptionFilter } from './filters/global-exception.filter'
import { ResponseInterceptor } from './interceptors/response.interceptor'

async function bootstrap() {
  const logger = new AppLogger('Bootstrap')
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  )
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()

  const configService = app.get(ConfigService)
  const port = configService.getOrThrow<number>('server.port')
  const apiPrefix = configService.getOrThrow<string>('server.apiPrefix')

  await app.register(helmet)
  await app.register(multipart)

  app.enableCors({
    origin: true,
    credentials: true,
  })
  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'internal/{*path}', method: RequestMethod.ALL },
    ],
  })

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: true,
      disableErrorMessages: process.env.NODE_ENV === 'production',
    }),
  )
  app.useGlobalFilters(new GlobalExceptionFilter())
  app.useGlobalInterceptors(
    new LoggerErrorInterceptor(),
    new ResponseInterceptor(),
  )

  await app.listen(port, '0.0.0.0')
  const appUrl = await app.getUrl()
  logger.log(`API is running on ${appUrl}/${apiPrefix}`)
}
bootstrap()
