import { z } from 'zod'

export const proxyModeSchema = z.enum(['system', 'direct', 'custom'])

export const proxyServerSchema = z.string().trim().max(2048).refine((value) => {
  if (!value)
    return true
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'socks5:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username && !url.password
      && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash
  }
  catch {
    return false
  }
}, 'Invalid proxy server')

export const proxySettingsSchema = z.object({
  mode: proxyModeSchema,
  server: proxyServerSchema,
}).strict().refine(value => value.mode !== 'custom' || Boolean(value.server), 'Proxy server is required')

export type ProxySettings = z.infer<typeof proxySettingsSchema>

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { mode: 'system', server: '' }
