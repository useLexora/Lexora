import type { FastifyInstance } from 'fastify'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'lexora-agent',
  }))
}
