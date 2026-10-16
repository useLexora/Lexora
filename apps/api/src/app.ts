import type { PrismaClient } from '@prisma/client'
import type { OAuthProviders } from './auth/providers.ts'
import type { Config } from './config.ts'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import Fastify, { LogController } from 'fastify'
import { ZodError } from 'zod'
import { createProviders } from './auth/providers.ts'
import { registerAuthRoutes } from './auth/routes.ts'
import { createAuth } from './auth/service.ts'
import { ApiError } from './errors.ts'
import { registerPluginRoutes } from './plugins/routes.ts'

export function createApp(db: PrismaClient, config: Config, options: { providers?: OAuthProviders, logger?: boolean } = {}) {
  const app = Fastify({ bodyLimit: 256 * 1024, logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }) })
  const providers = options.providers ?? createProviders(config)
  const auth = createAuth(db, config, providers)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (request.headers.origin !== config.PUBLIC_ORIGIN || request.headers['x-lexora-request'] !== 'community'))
      throw new ApiError(403, 'ORIGIN_REJECTED')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ errorCode: 'INVALID_INPUT' })
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ errorCode: error.errorCode })
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return reply.code(409).send({ errorCode: 'ALREADY_EXISTS' })
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status >= 500)
      request.log.error({ errorType: error instanceof Error ? error.name : 'Unknown', requestId: request.id }, 'Request failed')
    return reply.code(status).send({ errorCode: status === 413 ? 'REQUEST_TOO_LARGE' : 'REQUEST_FAILED' })
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode !== 200 || typeof payload !== 'string' || !String(reply.getHeader('Cache-Control')).startsWith('public,'))
      return payload
    const etag = `"${createHash('sha256').update(payload).digest('base64url')}"`
    reply.header('ETag', etag)
    const matches = request.headers['if-none-match']?.split(',').map(value => value.trim().replace(/^W\//, ''))
    if (matches?.includes(etag) || matches?.includes('*')) {
      reply.code(304)
      return ''
    }
    return payload
  })
  app.get('/api/health', async () => {
    await db.$queryRaw`SELECT 1`
    return { status: 'ok' }
  })
  registerAuthRoutes(app, auth, providers)
  registerPluginRoutes(app, db, auth)
  return app
}
