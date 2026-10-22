import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createWindowsSandboxPolicy } from '../../../service/src/sandbox/backends/windows/createPolicy'
import { inspectSandboxPath } from '../../../service/src/sandbox/sandboxFilesystemPolicy'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'

const execute = promisify(execFile)

async function powershell(root: string, script: string) {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return execute(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:PSModulePath=Join-Path $PSHOME 'Modules';$root=$env:LEXORA_ACL_TEST_ROOT;${script}`, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 30_000, env: { ...process.env, LEXORA_ACL_TEST_ROOT: root } })
}

async function withDeniedPath(run: (fixture: { root: string, denied: string, input: Parameters<typeof createWindowsSandboxPolicy>[0] }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-path-acl-')))
  const parent = join(root, 'denied')
  const denied = join(parent, 'child')
  try {
    await Promise.all(['workspace', 'home', 'shell', 'system/System32', 'search', 'normal-a', 'normal-b', 'denied/child', 'denied/System32'].map(path => mkdir(join(root, path), { recursive: true })))
    await powershell(root, `
      $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
      $paths=@('denied','denied\\child','denied\\System32')
      $saved=@($paths|ForEach-Object {@{relative=$_;sddl=(Get-Acl -LiteralPath (Join-Path $root $_)).Sddl}})
      ConvertTo-Json -InputObject $saved|Set-Content -LiteralPath (Join-Path $root 'acl.json') -Encoding utf8
      $path=Join-Path $root 'denied'
      $acl=Get-Acl -LiteralPath $path
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity.User,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $path -AclObject $acl
    `)
    expect(await realpath(parent)).toBe(parent)
    await expect(realpath(denied)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:EPERM|EACCES)$/) })
    await expect(realpath(join(parent, 'System32'))).rejects.toMatchObject({ code: expect.stringMatching(/^(?:EPERM|EACCES)$/) })
    const workspace = join(root, 'workspace')
    await run({
      root,
      denied,
      input: {
        roots: [workspace],
        workspaceRoots: [workspace],
        resourceReadRoots: [],
        additionalDirectories: [],
        cwd: workspace,
        home: join(root, 'home'),
        protectedRoots: [],
        sensitiveRoots: [],
        readOnly: false,
        backend: {
          kind: SHELL_SANDBOX_BACKEND.Windows,
          executable: join(root, 'unused-sandbox.exe'),
          shell: join(root, 'shell', 'pwsh.exe'),
          systemRoot: join(root, 'system'),
          protectionScope: join(root, 'home'),
        },
        searchDirectory: join(root, 'search'),
        path: [join(root, 'normal-a'), denied, join(root, 'normal-b')].join(';'),
      },
    })
  }
  finally {
    const saved = await readFile(join(root, 'acl.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      return undefined
    })
    if (saved) {
      await powershell(root, `
        $saved=Get-Content -Raw -LiteralPath (Join-Path $root 'acl.json')|ConvertFrom-Json
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetSecurityDescriptorSddlForm($saved[0].sddl,[Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath (Join-Path $root 'denied') -AclObject $acl
        foreach($entry in $saved){
          if((Get-Acl -LiteralPath (Join-Path $root $entry.relative)).Sddl -cne $entry.sddl){throw 'Fixture SDDL was not restored'}
        }
      `)
      expect(await realpath(denied)).toBe(denied)
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform !== 'win32')('windows sandbox policy with real ACL denial', () => {
  it('omits an inaccessible optional PATH child while retaining readable tools and their identities', async () => {
    await withDeniedPath(async ({ root, denied, input }) => {
      const policy = await createWindowsSandboxPolicy(input, new AbortController().signal)
      const expected = ['shell', 'system/System32', 'search', 'normal-a', 'normal-b'].map(path => join(root, path))
      expect(policy.path.split(';')).toEqual(expected)
      expect(policy.grants.some(grant => grant.path === denied)).toBe(false)
      expect(policy.grants.filter(grant => grant.access === 'read')).toEqual(await Promise.all(expected.map(path => inspectSandboxPath(path, 'read'))))
      expect(policy.grants.filter(grant => grant.access === 'write').map(grant => grant.path)).toEqual(input.roots)
    })
  }, 60_000)

  it('fails closed for inaccessible shell, System32, search, workspace, protected and sensitive roots', async () => {
    await withDeniedPath(async ({ root, denied, input }) => {
      const cases: Partial<typeof input>[] = [
        { backend: { ...input.backend, shell: join(denied, 'pwsh.exe') } },
        { backend: { ...input.backend, systemRoot: join(root, 'denied') } },
        { searchDirectory: denied },
        { roots: [denied], workspaceRoots: [denied], cwd: denied },
        { protectedRoots: [denied] },
        { sensitiveRoots: [denied] },
      ]
      for (const changes of cases)
        await expect(createWindowsSandboxPolicy({ ...input, ...changes }, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:EPERM|EACCES)$/) })
    })
  }, 60_000)

  it('does not swallow a replaced explicit grant identity when PATH also contains an inaccessible child', async () => {
    await withDeniedPath(async ({ root, input }) => {
      const directory = join(root, 'additional')
      await mkdir(directory)
      const grant = await inspectSandboxPath(directory, 'read')
      await rename(directory, join(root, 'original-additional'))
      await mkdir(directory)
      expect((await inspectSandboxPath(directory, 'read')).inode).not.toBe(grant.inode)
      await expect(createWindowsSandboxPolicy({
        ...input,
        additionalDirectories: [{ path: grant.path, access: 'read', device: grant.device, inode: grant.inode }],
      }, new AbortController().signal)).rejects.toMatchObject({ code: 'SANDBOX_DIRECTORY_CHANGED' })
    })
  }, 60_000)
})
