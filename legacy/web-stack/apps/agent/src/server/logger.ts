import type { FastifyServerOptions } from 'fastify'
import type { AgentConfig } from '../config/runtime-config'

export function createAgentFastifyLoggerOptions(logger: AgentConfig['logger']): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: logger.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'req.headers["x-api-key"]',
        'req.headers["x-app-internal-key"]',
      ],
      censor: '[Redacted]',
    },
    serializers: {
      req: request => ({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        remoteAddress: request.raw.socket?.remoteAddress,
        remotePort: request.raw.socket?.remotePort,
      }),
      res: response => ({
        statusCode: response.statusCode,
      }),
    },
    transport: logger.pretty
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
  }
}
