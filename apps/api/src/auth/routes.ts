import type { FastifyInstance } from 'fastify'
import type { OAuthProviders } from './providers.ts'
import type { Auth } from './service.ts'
import { providerSchema } from '@uselexora/lexora-contracts/community'
import { z } from 'zod'

export function registerAuthRoutes(app: FastifyInstance, auth: Auth, providers: OAuthProviders) {
  app.get('/api/session', async (request) => {
    const user = await auth.current(request)
    return { user: user ? { id: user.id, name: user.name, publisher: user.publisher && { id: user.publisher.id, handle: user.publisher.handle, displayName: user.publisher.displayName }, accounts: user.accounts.map(({ provider, subject }) => ({ provider, subject })), admin: user.admin } : null, providers: Object.keys(providers) }
  })
  app.post<{ Params: { provider: string } }>('/api/auth/:provider/start', async (request, reply) => {
    const body = z.object({ link: z.boolean().default(false) }).strict().parse(request.body)
    return auth.begin(request, reply, providerSchema.parse(request.params.provider), body.link)
  })
  app.get<{ Params: { provider: string } }>('/api/auth/:provider/callback', (request, reply) => auth.callback(request, reply, providerSchema.parse(request.params.provider)))
  app.post('/api/auth/logout', (request, reply) => auth.logout(request, reply))
}
