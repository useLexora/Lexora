import { describe, expect, it } from 'vitest'
import { browserPreferencesSchema, DEFAULT_BROWSER_PREFERENCES } from '../../browser/browserPreferences'
import {
  DEFAULT_NETWORK_PERMISSIONS,
  findNetworkPermissionRule,
  networkPermissionsSchema,
  normalizeNetworkHost,
  resolveNetworkPermission,
  upsertNetworkPermission,
} from '../networkPermissions'
import { compileNetworkRegex } from '../safeNetworkRegex'

function rule(id: string, pattern: string, match: 'exact' | 'subdomains' | 'regex', access: 'ask' | 'allow' | 'deny' = 'allow') {
  return { id, pattern, match, access, download: 'deny' as const, upload: 'ask' as const }
}

describe('network permissions', () => {
  it('defaults old preferences to ask and rejects unknown decisions and ambiguous duplicate identities', () => {
    const { networkPermissions: _, ...legacy } = DEFAULT_BROWSER_PREFERENCES
    expect(browserPreferencesSchema.parse(legacy).networkPermissions).toEqual(DEFAULT_NETWORK_PERMISSIONS)
    expect(networkPermissionsSchema.safeParse({ ...DEFAULT_NETWORK_PERMISSIONS, defaults: { access: 'inherit', download: 'ask', upload: 'ask' } }).success).toBe(false)
    expect(networkPermissionsSchema.safeParse({ ...DEFAULT_NETWORK_PERMISSIONS, rules: [rule('a', 'example.com', 'exact'), rule('a', 'other.com', 'exact')] }).success).toBe(false)
    expect(networkPermissionsSchema.safeParse({ ...DEFAULT_NETWORK_PERMISSIONS, rules: [rule('a', 'EXAMPLE.COM.', 'exact'), rule('b', 'example.com', 'exact')] }).success).toBe(false)
    expect(networkPermissionsSchema.safeParse({ ...DEFAULT_NETWORK_PERMISSIONS, rules: Array.from({ length: 101 }, (_, i) => rule(String(i), `host${i}.test`, 'exact')) }).success).toBe(false)
  })

  it('normalizes IDNA, case, trailing dots and IPs, never URL paths or ports', () => {
    expect(normalizeNetworkHost('  EXAMPLE.COM. ')).toBe('example.com')
    expect(normalizeNetworkHost('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d')
    expect(normalizeNetworkHost('[2001:0DB8::1]')).toBe('[2001:db8::1]')
    expect(normalizeNetworkHost('127.0.0.1')).toBe('127.0.0.1')
    for (const host of ['https://example.com', 'example.com:443', 'example.com/path', 'example.com?x', 'example.com#x', 'user@example.com', '*.example.com', 'example.com\\evil', 'example..com', '-host.com', 'a'.repeat(64), 'a%2ecom']) {
      expect(normalizeNetworkHost(host), host).toBeNull()
      expect(resolveNetworkPermission({ defaults: { access: 'allow', download: 'allow', upload: 'allow' }, rules: [] }, host, 'access'), host).toBe('deny')
    }
  })

  it('uses exact, longest subdomain suffix, then first regex, without inheriting operations', () => {
    const settings = networkPermissionsSchema.parse({
      defaults: { access: 'deny', download: 'allow', upload: 'allow' },
      rules: [
        rule('regex-first', '.*\\.example\\.com', 'regex', 'deny'),
        rule('regex-second', '.*', 'regex', 'allow'),
        rule('root', 'example.com', 'subdomains', 'allow'),
        rule('nested', 'team.example.com', 'subdomains', 'deny'),
        rule('exact', 'api.team.example.com', 'exact', 'ask'),
      ],
    })
    expect(findNetworkPermissionRule(settings, 'API.TEAM.EXAMPLE.COM.')?.id).toBe('exact')
    expect(findNetworkPermissionRule(settings, 'deep.team.example.com')?.id).toBe('nested')
    expect(findNetworkPermissionRule(settings, 'example.com')?.id).toBe('root')
    expect(findNetworkPermissionRule(settings, 'deep.example.com')?.id).toBe('root')
    expect(findNetworkPermissionRule({ ...settings, rules: settings.rules.slice(0, 2) }, 'api.example.com')?.id).toBe('regex-first')
    expect(resolveNetworkPermission(settings, 'api.team.example.com', 'upload')).toBe('ask')
    expect(resolveNetworkPermission({ ...settings, rules: [settings.rules[2]!] }, 'notexample.com', 'access')).toBe('deny')
    expect(resolveNetworkPermission({ ...settings, rules: [] }, 'example.com', 'download')).toBe('allow')
  })

  it('upserts only the requested operation while preserving effective decisions and exact IDs', () => {
    const original = networkPermissionsSchema.parse({ ...DEFAULT_NETWORK_PERMISSIONS, rules: [rule('root', 'example.com', 'subdomains', 'deny')] })
    const first = upsertNetworkPermission(original, 'API.EXAMPLE.COM.', 'upload')
    expect(first.rules[1]).toMatchObject({ match: 'exact', pattern: 'api.example.com', access: 'deny', download: 'deny', upload: 'allow' })
    const next = upsertNetworkPermission(first, 'api.example.com', 'download')
    expect(next.rules[1]).toMatchObject({ id: first.rules[1]!.id, access: 'deny', download: 'allow', upload: 'allow' })
    expect(next.rules).toHaveLength(2)
    expect(original.rules).toHaveLength(1)
    expect(() => upsertNetworkPermission(original, 'https://example.com', 'access')).toThrow()
  })
})

describe('bounded non-backtracking host regex', () => {
  it.each([
    ['^([a-z0-9-]+\\.)?example\\.com$', ['example.com', 'api.example.com'], ['api.otherexample.com', 'deep.api.example.com', 'example.com.evil']],
    ['(?:api|cdn)\\d+\\.example\\.com', ['api12.example.com', 'cdn1.example.com'], ['api.example.com', 'xapi1.example.com']],
    ['[^.]+\\.test', ['abc.test'], ['a.b.test', 'test']],
    ['a?b*\\.test', ['a.test', 'bbb.test', 'ab.test'], ['ba.test']],
  ])('matches the complete hostname with %s', (pattern, yes, no) => {
    const match = compileNetworkRegex(pattern)
    expect(match).not.toBeNull()
    for (const host of yes)
      expect(match!(host), host).toBe(true)
    for (const host of no)
      expect(match!(host), host).toBe(false)
  })

  it('rejects unsupported syntax, excessive depth, invalid ranges and oversized patterns', () => {
    for (const pattern of ['/example/i', '(?=a)a', '(?<=a)b', '(a)\\1', 'a{2,3}', 'a+?', 'a||b', '()', '[z-a]', '[a', '\\p{L}', '\\k<x>', '^$', 'a^b', 'a$b', `${'('.repeat(17)}a${')'.repeat(17)}`, 'a'.repeat(257), 'a?'.repeat(128)]) {
      expect(compileNetworkRegex(pattern), pattern).toBeNull()
      expect(networkPermissionsSchema.safeParse({ ...DEFAULT_NETWORK_PERMISSIONS, rules: [rule('x', pattern, 'regex')] }).success, pattern).toBe(false)
    }
  })

  it('handles adversarial nested repetition in bounded time without backtracking', () => {
    for (const pattern of ['(a+)+b', '(a|aa)+b', '((a?)*)*b']) {
      const match = compileNetworkRegex(pattern)!
      expect(match('a'.repeat(253))).toBe(false)
      expect(match(`${'a'.repeat(252)}b`)).toBe(true)
    }
  }, 1000)
})
