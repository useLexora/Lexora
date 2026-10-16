import type { PrismaClient } from '@prisma/client'
import type { Provider } from '@uselexora/lexora-contracts/community'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import type { OAuthProviders } from './providers.ts'
import { createHash, randomBytes } from 'node:crypto'
import { parse, serialize } from 'cookie'
import { ApiError } from '../errors.ts'

export function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
const token = () => randomBytes(32).toString('base64url')
const sessionLifetime = 30 * 24 * 60 * 60

export function createAuth(db: PrismaClient, config: Config, providers: OAuthProviders) {
  const sessionName = config.secureCookies ? '__Host-lexora_session' : 'lexora_session'
  const flowName = config.secureCookies ? '__Host-lexora_oauth' : 'lexora_oauth'
  const cookie = (name: string, value: string, maxAge: number) => serialize(name, value, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/', maxAge })
  const sessionHash = (request: FastifyRequest) => hashToken(parse(request.headers.cookie ?? '')[sessionName] ?? '')
  async function current(request: FastifyRequest) {
    const session = await db.session.findUnique({ where: { tokenHash: sessionHash(request) }, include: { user: { include: { accounts: true, publisher: true } } } })
    if (!session || session.expiresAt.getTime() <= Date.now())
      return null
    const user = session.user
    return { ...user, admin: user.accounts.some(account => config.adminIdentities.has(`${account.provider}:${account.subject}`)) }
  }
  async function requireUser(request: FastifyRequest) {
    const user = await current(request)
    if (!user)
      throw new ApiError(401, 'LOGIN_REQUIRED')
    return user
  }
  async function begin(request: FastifyRequest, reply: FastifyReply, provider: Provider, link: boolean) {
    const runtime = providers[provider]
    if (!runtime)
      throw new ApiError(404, 'PROVIDER_UNAVAILABLE')
    const user = link ? await requireUser(request) : null
    const binding = token()
    const flow = { state: token(), verifier: token(), nonce: token(), provider, bindingHash: hashToken(binding), userId: user?.id, sessionHash: link ? sessionHash(request) : null, expiresAt: new Date(Date.now() + 10 * 60000) }
    const url = await runtime.authorize(flow)
    await db.oAuthFlow.create({ data: flow })
    reply.header('Set-Cookie', cookie(flowName, binding, 600))
    return { url }
  }
  async function callback(request: FastifyRequest, reply: FastifyReply, provider: Provider) {
    const url = new URL(request.url, config.PUBLIC_ORIGIN)
    const state = url.searchParams.get('state') ?? ''
    const flow = await db.oAuthFlow.findUnique({ where: { state } })
    const binding = parse(request.headers.cookie ?? '')[flowName] ?? ''
    if (!flow || flow.provider !== provider || flow.expiresAt.getTime() <= Date.now() || flow.bindingHash !== hashToken(binding))
      throw new ApiError(400, 'OAUTH_STATE_INVALID')
    if (flow.userId) {
      const user = await requireUser(request)
      if (user.id !== flow.userId || flow.sessionHash !== sessionHash(request))
        throw new ApiError(403, 'OAUTH_STATE_INVALID')
    }
    const consumed = await db.oAuthFlow.deleteMany({ where: { state: flow.state, bindingHash: flow.bindingHash } })
    if (consumed.count !== 1)
      throw new ApiError(400, 'OAUTH_STATE_INVALID')
    const runtime = providers[provider]
    if (!runtime)
      throw new ApiError(404, 'PROVIDER_UNAVAILABLE')
    const identity = await runtime.exchange(url, flow)
    const newToken = token()
    await db.$transaction(async (tx) => {
      const account = await tx.oAuthAccount.findUnique({ where: { provider_subject: { provider, subject: identity.subject } } })
      if (flow.userId && account && account.userId !== flow.userId)
        throw new ApiError(409, 'ACCOUNT_ALREADY_LINKED')
      let userId = account?.userId ?? flow.userId
      if (!userId) {
        const user = await tx.user.create({ data: { name: identity.name } })
        userId = user.id
      }
      if (!account)
        await tx.oAuthAccount.create({ data: { provider, subject: identity.subject, userId } })
      await tx.session.deleteMany({ where: { tokenHash: sessionHash(request) } })
      await tx.session.create({ data: { tokenHash: hashToken(newToken), userId, expiresAt: new Date(Date.now() + sessionLifetime * 1000) } })
    })
    reply.header('Set-Cookie', [cookie(sessionName, newToken, sessionLifetime), cookie(flowName, '', 0)])
    return reply.redirect(`${config.PUBLIC_ORIGIN}/account`)
  }
  async function logout(request: FastifyRequest, reply: FastifyReply) {
    await db.session.deleteMany({ where: { tokenHash: sessionHash(request) } })
    reply.header('Set-Cookie', cookie(sessionName, '', 0))
    return { ok: true }
  }
  return { current, requireUser, begin, callback, logout }
}
export type Auth = ReturnType<typeof createAuth>
