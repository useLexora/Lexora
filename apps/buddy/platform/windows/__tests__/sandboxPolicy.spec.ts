import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveSensitivePathRoots } from '../../../service/src/permissions/sensitivePaths'
import { createWindowsSandboxPolicy } from '../../../service/src/sandbox/backends/windows/createPolicy'
import { sandboxCommandSchema, sandboxProcessInputSchema } from '../../../shared/permissions/shellSandbox'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'

const failures = vi.hoisted(() => ({ realpath: new Map<string, string>(), stat: new Map<string, string>() }))

vi.mock('../../currentPlatform', async () => {
  const { resolveBuddyPlatform } = await import('../../../shared/platform')
  return { currentPlatform: resolveBuddyPlatform('win32') }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, ...actual.win32 }
})
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => {
    const code = failures.realpath.get(path)
    if (code)
      throw Object.assign(new Error(code), { code })
    return path === 'Z:\\MappedTools' ? '\\\\server\\tools' : path
  },
  stat: async (path: string) => {
    const code = failures.stat.get(path)
    if (code)
      throw Object.assign(new Error(code), { code })
    return { isDirectory: () => true, dev: 1n, ino: 2n }
  },
}))

const home = 'C:\\Users\\Fixture'
const input = {
  command: 'Write-Output ok',
  requestId: '00000000-0000-4000-8000-000000000001',
  roots: ['C:\\workspace'],
  workspaceRoots: ['C:\\workspace'],
  resourceReadRoots: [],
  additionalDirectories: [],
  cwd: 'C:\\workspace',
  home,
  privateRoot: 'C:\\private',
  protectedRoots: [],
  sensitiveRoots: resolveSensitivePathRoots({ home, environment: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local', SystemRoot: 'C:\\Windows' } }),
  readOnly: false,
  backend: { kind: SHELL_SANDBOX_BACKEND.Windows, protectionScope: home, executable: 'C:\\sandbox.exe', shell: 'C:\\PowerShell\\pwsh.exe', systemRoot: 'C:\\Windows' },
  searchDirectory: 'C:\\search',
  path: '',
}

describe('windows sandbox policy assembly', () => {
  beforeEach(() => {
    failures.realpath.clear()
    failures.stat.clear()
  })

  it('retains local PATH tools without turning UNC or device paths into mandatory grants', async () => {
    const policy = await createWindowsSandboxPolicy({ ...input, path: '"D:\\Tools";\\\\server\\tools;//server/share;\\\\?\\C:\\tools;C:relative;\\root-relative;C:\\NUL\\..\\tools;Z:\\MappedTools' }, new AbortController().signal)
    expect(policy.path.split(';')).toEqual(['C:\\PowerShell', 'C:\\Windows\\System32', 'C:\\search', 'D:\\Tools'])
    expect(policy.grants.filter(grant => grant.access === 'read').map(grant => grant.path)).toEqual(policy.path.split(';'))
    expect(sandboxCommandSchema.safeParse({ command: input.command, requestId: input.requestId, cwd: '\\\\server\\tools', roots: ['\\\\server\\tools'], readOnly: false }).success).toBe(false)
  })

  it.each([
    ['realpath', 'EPERM'],
    ['realpath', 'EACCES'],
    ['stat', 'EPERM'],
    ['stat', 'EACCES'],
  ] as const)('skips inaccessible optional PATH entries during %s (%s)', async (operation, code) => {
    failures[operation].set('D:\\Locked', code)
    const policy = await createWindowsSandboxPolicy({ ...input, path: 'D:\\Locked;D:\\Tools;D:\\Tools' }, new AbortController().signal)
    expect(policy.path.split(';')).toEqual(['C:\\PowerShell', 'C:\\Windows\\System32', 'C:\\search', 'D:\\Tools'])
    expect(policy.grants.filter(grant => grant.access === 'read').map(grant => grant.path)).toEqual(policy.path.split(';'))
    expect(policy.grants.some(grant => grant.path === 'D:\\Locked')).toBe(false)
  })

  it.each(['realpath', 'stat'] as const)('retains required directory failures during %s', async (operation) => {
    const required = ['C:\\workspace', 'C:\\PowerShell', 'C:\\Windows\\System32', 'C:\\search', 'D:\\Roaming\\gcloud', 'C:\\protected']
    for (const path of required) {
      failures[operation].set(path, 'EPERM')
      await expect(createWindowsSandboxPolicy({ ...input, path: 'D:\\Tools', protectedRoots: ['C:\\protected'] }, new AbortController().signal))
        .rejects
        .toMatchObject({ code: 'EPERM' })
      failures[operation].clear()
    }
  })

  it.each(['realpath', 'stat'] as const)('does not swallow unexpected PATH IO errors during %s', async (operation) => {
    failures[operation].set('D:\\Broken', 'EIO')
    await expect(createWindowsSandboxPolicy({ ...input, path: 'D:\\Broken;D:\\Tools' }, new AbortController().signal))
      .rejects
      .toMatchObject({ code: 'EIO' })
  })

  it('protects redirected credentials on another volume and rejects them as workspace roots', async () => {
    const policy = await createWindowsSandboxPolicy(input, new AbortController().signal)
    expect(policy.grants.filter(grant => grant.access === 'denyRead').map(grant => grant.path)).toEqual(expect.arrayContaining([
      'C:\\Users\\Fixture\\.netrc',
      'C:\\Users\\Fixture\\_netrc',
      'D:\\Roaming\\gcloud',
      'D:\\Local\\Microsoft\\Vault',
      'D:\\Local\\Google\\Chrome\\User Data',
    ]))
    expect(policy.grants.map(grant => grant.path)).not.toContain('C:\\Windows\\System32\\config')
    for (const root of ['D:\\Roaming\\gcloud', 'C:\\Windows\\System32\\config']) {
      await expect(createWindowsSandboxPolicy({ ...input, roots: [root], workspaceRoots: [root], cwd: root }, new AbortController().signal)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    }
  })

  it('protects credentials in every user home and relocated package-manager store', async () => {
    const sensitiveRoots = resolveSensitivePathRoots({
      home,
      environment: {
        Home: 'D:\\Git Home',
        UserProfile: home,
        HomeDrive: 'H:',
        HomePath: '\\Home',
        AppData: 'D:\\Roaming',
        LocalAppData: 'D:\\Local',
        CARGO_HOME: 'D:\\Cargo',
        NPM_CONFIG_USERCONFIG: 'D:\\Config\\npmrc',
      },
    })
    const policy = await createWindowsSandboxPolicy({ ...input, sensitiveRoots }, new AbortController().signal)
    const denied = policy.grants.filter(grant => grant.access === 'denyRead').map(grant => grant.path)
    expect(denied).toEqual(expect.arrayContaining([
      'C:\\Users\\Fixture\\.ssh',
      'D:\\Git Home\\.ssh',
      'D:\\Git Home\\.npmrc',
      'H:\\Home\\.netrc',
      'D:\\Cargo\\credentials',
      'D:\\Cargo\\credentials.toml',
      'D:\\Config\\npmrc',
      'D:\\Roaming\\gcloud',
    ]))
    expect(denied).not.toContain('D:\\Git Home\\.config\\mise')
    await expect(createWindowsSandboxPolicy({ ...input, sensitiveRoots, roots: ['D:\\Git Home\\.ssh'], workspaceRoots: ['D:\\Git Home\\.ssh'], cwd: 'D:\\Git Home\\.ssh' }, new AbortController().signal))
      .rejects
      .toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })

  it('requires host protection data without letting command callers supply it', () => {
    expect(sandboxProcessInputSchema.safeParse(input).success).toBe(true)
    expect(sandboxProcessInputSchema.safeParse({ ...input, sensitiveRoots: undefined }).success).toBe(false)
    expect(sandboxCommandSchema.safeParse({ command: input.command, requestId: input.requestId, cwd: input.cwd, roots: input.roots, readOnly: false, sensitiveRoots: [] }).success).toBe(false)
  })
})
