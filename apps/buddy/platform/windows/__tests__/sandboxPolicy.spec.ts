import { describe, expect, it, vi } from 'vitest'
import { resolveSensitivePathRoots } from '../../../service/src/permissions/sensitivePaths'
import { createWindowsSandboxPolicy } from '../../../service/src/sandbox/backends/windows/createPolicy'
import { sandboxCommandSchema, sandboxProcessInputSchema } from '../../../shared/permissions/shellSandbox'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'

vi.mock('../../currentPlatform', async () => {
  const { resolveBuddyPlatform } = await import('../../../shared/platform')
  return { currentPlatform: resolveBuddyPlatform('win32') }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, ...actual.win32 }
})
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path === 'Z:\\MappedTools' ? '\\\\server\\tools' : path,
  stat: async () => ({ isDirectory: () => true, dev: 1n, ino: 2n }),
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
  it('retains local PATH tools without turning UNC or device paths into mandatory grants', async () => {
    const policy = await createWindowsSandboxPolicy({ ...input, path: '"D:\\Tools";\\\\server\\tools;//server/share;\\\\?\\C:\\tools;C:relative;\\root-relative;C:\\NUL\\..\\tools;Z:\\MappedTools' }, new AbortController().signal)
    expect(policy.path.split(';')).toEqual(['C:\\PowerShell', 'C:\\Windows\\System32', 'C:\\search', 'D:\\Tools'])
    expect(policy.grants.filter(grant => grant.access === 'read').map(grant => grant.path)).toEqual(policy.path.split(';'))
    expect(sandboxCommandSchema.safeParse({ command: input.command, requestId: input.requestId, cwd: '\\\\server\\tools', roots: ['\\\\server\\tools'], readOnly: false }).success).toBe(false)
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

  it('requires host protection data without letting command callers supply it', () => {
    expect(sandboxProcessInputSchema.safeParse(input).success).toBe(true)
    expect(sandboxProcessInputSchema.safeParse({ ...input, sensitiveRoots: undefined }).success).toBe(false)
    expect(sandboxCommandSchema.safeParse({ command: input.command, requestId: input.requestId, cwd: input.cwd, roots: input.roots, readOnly: false, sensitiveRoots: [] }).success).toBe(false)
  })
})
