import type { Provider } from '@uselexora/lexora-contracts/community'
import type { Config } from '../config.ts'
import * as oidc from 'openid-client'
import { ApiError } from '../errors.ts'

const definitions = {
  'github': { prefix: 'GITHUB', issuer: 'https://github.com/login/oauth', authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user', scope: 'read:user' },
  'google': { prefix: 'GOOGLE', issuer: 'https://accounts.google.com', authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', jwks: 'https://www.googleapis.com/oauth2/v3/certs', scope: 'openid profile email' },
  'linux-do': { prefix: 'LINUX_DO', issuer: 'https://connect.linux.do/', authorization: 'https://connect.linux.do/oauth2/authorize', token: 'https://connect.linux.do/oauth2/token', userinfo: 'https://connect.linux.do/api/user', jwks: 'https://connect.linux.do/.well-known/jwks.json', scope: 'openid profile' },
}

export interface OAuthIdentity { subject: string, name: string }
export interface OAuthChecks { state: string, verifier: string, nonce: string }
export interface OAuthProvider {
  authorize: (checks: OAuthChecks) => Promise<string>
  exchange: (url: URL, checks: OAuthChecks) => Promise<OAuthIdentity>
}
export type OAuthProviders = Partial<Record<Provider, OAuthProvider>>

export function createProviders(config: Config): OAuthProviders {
  const providers: OAuthProviders = {}
  for (const [key, definition] of Object.entries(definitions)) {
    const provider = key as Provider
    const clientId = config.env[`${definition.prefix}_CLIENT_ID`]
    const secret = config.env[`${definition.prefix}_CLIENT_SECRET`]
    if (!clientId || !secret)
      continue
    const endpoint = (url: string) => {
      if (!config.OAUTH_PROXY_URL)
        return url
      const paths: Record<string, string> = {
        'https://github.com/login/oauth/access_token': '/github/access_token',
        'https://api.github.com/user': '/github/user',
        'https://oauth2.googleapis.com/token': '/google/token',
        'https://openidconnect.googleapis.com/v1/userinfo': '/google/userinfo',
        'https://www.googleapis.com/oauth2/v3/certs': '/google/certs',
      }
      const path = paths[url] ?? `/linux-do${new URL(url).pathname}`
      return `${config.OAUTH_PROXY_URL.replace(/\/$/, '')}${path}`
    }
    const runtime = new oidc.Configuration({
      issuer: definition.issuer,
      authorization_endpoint: definition.authorization,
      token_endpoint: endpoint(definition.token),
      userinfo_endpoint: endpoint(definition.userinfo),
      ...('jwks' in definition ? { jwks_uri: endpoint(definition.jwks) } : {}),
    }, clientId, secret)
    runtime.timeout = 15
    const redirectUri = `${config.PUBLIC_ORIGIN}/api/auth/${provider}/callback`
    providers[provider] = {
      async authorize(checks) {
        return oidc.buildAuthorizationUrl(runtime, {
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: definition.scope,
          state: checks.state,
          code_challenge: await oidc.calculatePKCECodeChallenge(checks.verifier),
          code_challenge_method: 'S256',
          ...(provider === 'google' ? { nonce: checks.nonce } : {}),
        }).href
      },
      async exchange(url, checks) {
        const tokens = await oidc.authorizationCodeGrant(runtime, url, {
          expectedState: checks.state,
          pkceCodeVerifier: checks.verifier,
          ...(provider === 'google' ? { expectedNonce: checks.nonce, idTokenExpected: true } : {}),
        }, { redirect_uri: redirectUri })
        const response = await fetch(endpoint(definition.userinfo), {
          headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json', 'User-Agent': 'Lexora-Community' },
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        })
        if (!response.ok)
          throw new ApiError(502, 'OAUTH_PROVIDER_FAILED')
        const profile = await response.json() as Record<string, unknown>
        const subject = provider === 'github' ? profile.id : profile.sub ?? profile.id
        if ((typeof subject !== 'string' && typeof subject !== 'number') || !String(subject).length || String(subject).length > 200)
          throw new ApiError(502, 'OAUTH_PROVIDER_FAILED')
        if (provider === 'google' && tokens.claims()?.sub !== subject)
          throw new ApiError(502, 'OAUTH_PROVIDER_FAILED')
        const name = [profile.name, profile.preferred_username, profile.username, profile.login].find(value => typeof value === 'string' && value.trim())
        return { subject: String(subject), name: typeof name === 'string' ? name.slice(0, 80) : 'Lexora user' }
      },
    }
  }
  return providers
}
