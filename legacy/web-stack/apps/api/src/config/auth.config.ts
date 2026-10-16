import { registerAs } from '@nestjs/config'
import { getDerivedSecretMaterial } from './app-secret'
import { getEnv } from './env.schema'

const JWT_DEFAULTS = {
  issuer: 'lexora-api',
  audience: 'lexora-web',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 60 * 60 * 24 * 30,
} satisfies Omit<JwtConfig, 'accessSecret'>

const GITHUB_OAUTH_DEFAULT_URL = 'https://github.com/login/oauth'
const GITHUB_OAUTH_ISSUER = 'https://github.com/login/oauth'
const GITHUB_USERINFO_DEFAULT_ENDPOINT = 'https://api.github.com/user'

const LINUX_DO_OAUTH_DEFAULT_URL = 'https://connect.linux.do'
const LINUX_DO_OAUTH_ISSUER = 'https://connect.linux.do/'

const GOOGLE_OAUTH_DEFAULT_URL = 'https://accounts.google.com'
const GOOGLE_OAUTH_ISSUER = 'https://accounts.google.com'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs'

/**
 * JWT 签发与校验配置
 */
export interface JwtConfig {
  issuer: string
  audience: string
  accessSecret: string
  accessTtlSeconds: number
  refreshTtlSeconds: number
}

/**
 * OAuth 提供商运行时配置
 */
export interface OAuthProviderConfig {
  clientId?: string
  clientSecret?: string
  issuer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userinfoEndpoint?: string
  jwksEndpoint?: string
  scopes: string
}

/**
 * OAuth 配置
 */
export interface OAuthConfig {
  google: OAuthProviderConfig
  github: OAuthProviderConfig
  linuxDo: OAuthProviderConfig
}

export const jwtConfig = registerAs('jwt', (): JwtConfig => ({
  ...JWT_DEFAULTS,
  accessSecret: getDerivedSecretMaterial().jwtAccessSecret,
}))

export const oauthConfig = registerAs('oauth', (): OAuthConfig => ({
  google: createGoogleOAuthConfig(),
  github: createGithubOAuthConfig(),
  linuxDo: createLinuxDoOAuthConfig(),
}))

function createGithubOAuthConfig(): OAuthProviderConfig {
  const env = getEnv()
  const oauthUrl = normalizeOAuthUrl(env.OAUTH_PROXY_URL ?? GITHUB_OAUTH_DEFAULT_URL)
  const useDefaultUserinfoEndpoint = oauthUrl === GITHUB_OAUTH_DEFAULT_URL

  return {
    issuer: GITHUB_OAUTH_ISSUER,
    authorizationEndpoint: appendOAuthUrlPath(oauthUrl, 'github', 'authorize'),
    tokenEndpoint: appendOAuthUrlPath(oauthUrl, 'github', 'access_token'),
    userinfoEndpoint: useDefaultUserinfoEndpoint
      ? GITHUB_USERINFO_DEFAULT_ENDPOINT
      : appendOAuthUrlPath(oauthUrl, 'github', 'user'),
    scopes: 'read:user',
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  }
}

function createLinuxDoOAuthConfig(): OAuthProviderConfig {
  const env = getEnv()
  const oauthUrl = normalizeOAuthUrl(env.OAUTH_PROXY_URL ?? LINUX_DO_OAUTH_DEFAULT_URL)

  return {
    issuer: LINUX_DO_OAUTH_ISSUER,
    authorizationEndpoint: appendOAuthUrlPath(oauthUrl, 'linux-do', 'oauth2/authorize'),
    tokenEndpoint: appendOAuthUrlPath(oauthUrl, 'linux-do', 'oauth2/token'),
    userinfoEndpoint: appendOAuthUrlPath(oauthUrl, 'linux-do', 'api/user'),
    jwksEndpoint: appendOAuthUrlPath(oauthUrl, 'linux-do', '.well-known/jwks.json'),
    scopes: 'openid profile',
    clientId: env.LINUX_DO_CLIENT_ID,
    clientSecret: env.LINUX_DO_CLIENT_SECRET,
  }
}

function createGoogleOAuthConfig(): OAuthProviderConfig {
  const env = getEnv()
  const oauthUrl = normalizeOAuthUrl(env.OAUTH_PROXY_URL ?? GOOGLE_OAUTH_DEFAULT_URL)
  const useDefaultEndpoint = oauthUrl === GOOGLE_OAUTH_DEFAULT_URL

  return {
    issuer: GOOGLE_OAUTH_ISSUER,
    authorizationEndpoint: useDefaultEndpoint
      ? appendUrlPath(oauthUrl, 'o/oauth2/v2/auth')
      : appendOAuthUrlPath(oauthUrl, 'google', 'o/oauth2/v2/auth'),
    tokenEndpoint: useDefaultEndpoint
      ? GOOGLE_TOKEN_ENDPOINT
      : appendOAuthUrlPath(oauthUrl, 'google', 'token'),
    userinfoEndpoint: useDefaultEndpoint
      ? GOOGLE_USERINFO_ENDPOINT
      : appendOAuthUrlPath(oauthUrl, 'google', 'userinfo'),
    jwksEndpoint: useDefaultEndpoint
      ? GOOGLE_JWKS_ENDPOINT
      : appendOAuthUrlPath(oauthUrl, 'google', 'certs'),
    scopes: 'openid profile email',
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  }
}

function normalizeOAuthUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim())
  url.pathname = url.pathname.replace(/\/+$/g, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/g, '')
}

function appendOAuthUrlPath(baseUrl: string, proxyProviderPath: string, defaultProviderPath: string): string {
  const providerPath = baseUrl === GITHUB_OAUTH_DEFAULT_URL || baseUrl === LINUX_DO_OAUTH_DEFAULT_URL || baseUrl === GOOGLE_OAUTH_DEFAULT_URL
    ? defaultProviderPath
    : `${proxyProviderPath}/${defaultProviderPath}`

  return appendUrlPath(baseUrl, providerPath)
}

function appendUrlPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/g, '')
  const nextPath = path.replace(/^\/+/g, '')
  url.pathname = `${basePath}/${nextPath}`
  return url.toString()
}

export interface CryptoConfig {
  encryptionKey: string
}

export const cryptoConfig = registerAs('crypto', (): CryptoConfig => ({
  encryptionKey: getDerivedSecretMaterial().encryptionKey,
}))

export interface BootstrapConfig {
  systemAdminEmail: string
}

export const bootstrapConfig = registerAs('bootstrap', (): BootstrapConfig => ({
  systemAdminEmail: getEnv().SYSTEM_ADMIN,
}))
