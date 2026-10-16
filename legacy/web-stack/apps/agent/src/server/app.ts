import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../config/runtime-config'
import type { AgentServerLifecycle } from './lifecycle'
import { randomUUID } from 'node:crypto'
import fastify from 'fastify'
import { registerAgentServerCloseHook } from './lifecycle'
import { createAgentFastifyLoggerOptions } from './logger'
import { resolveHeaderRequestId } from './request'
import { registerHealthRoutes } from './routes/health'

/** 创建 Agent 服务输入。 */
export interface CreateAgentServerOptions {
  config: AgentConfig
  lifecycle?: AgentServerLifecycle
}

export function createAgentServer(options: CreateAgentServerOptions): FastifyInstance {
  const app = fastify({
    disableRequestLogging: request => request.url?.startsWith('/healthz') ?? false,
    genReqId: request => resolveHeaderRequestId(request.headers['x-request-id']) ?? randomUUID(),
    logger: createAgentFastifyLoggerOptions(options.config.logger),
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  registerHealthRoutes(app)
  registerAgentServerCloseHook({
    app,
    lifecycle: options.lifecycle,
  })

  return app
}
