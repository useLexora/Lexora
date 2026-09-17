import type { SandboxProcessInput } from '../../../shared/permissions/shellSandbox'
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'
import { createSensitivePathMatcher, resolveSensitivePathRoots } from '../permissions/sensitivePaths'
import { validateSandboxDirectory } from './SandboxDirectoryPermissions'

const execute = promisify(execFile)
const SECRET_GLOBS = ['.env', '.env.*', '.netrc', '_netrc', '.pgpass', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.pem', '*.p12', '*.pfx']
export const SANDBOX_TOOLCHAIN_PATHS = ['.local/share/fnm/node-versions', '.nvm/versions', '.volta/tools', '.asdf/installs', '.rustup/toolchains', '.cargo/bin']

export interface SandboxFilesystemGrant {
  path: string
  access: 'read' | 'write' | 'denyRead' | 'denyWrite'
  device: string
  inode: string
  exceptions: string[]
}

export async function inspectSandboxPath(path: string, access: SandboxFilesystemGrant['access']): Promise<SandboxFilesystemGrant> {
  const canonical = await realpath(path)
  if (filePaths.sensitiveKey(canonical) !== filePaths.sensitiveKey(path))
    throw new ShellSandboxError('SANDBOX_DIRECTORY_CHANGED')
  const metadata = await stat(canonical, { bigint: true })
  return { path: canonical, access, device: String(metadata.dev), inode: String(metadata.ino), exceptions: [] }
}

export async function existingSandboxPaths(paths: readonly string[]): Promise<string[]> {
  const result: string[] = []
  for (const path of paths) {
    try {
      result.push(await realpath(path))
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code)))
        throw error
    }
  }
  return [...new Set(result)]
}

export async function createSandboxFilesystemPolicy(input: SandboxProcessInput, rg: string, signal: AbortSignal): Promise<SandboxFilesystemGrant[]> {
  signal.throwIfAborted()
  await Promise.all(input.additionalDirectories.map(validateSandboxDirectory))
  const resources = (input.resourceReadRoots ?? []).filter(root => !input.roots.some(parent => containsCanonicalPath(parent, root)))
  const roots = [...new Set([...input.roots, ...input.additionalDirectories.map(grant => grant.path), ...resources])]
  const workspaces = input.workspaceRoots.filter(root => input.roots.includes(root))
  const sensitiveOptions = { home: input.home, environment: input.backend.kind === SHELL_SANDBOX_BACKEND.Windows ? { SystemRoot: input.backend.systemRoot } : {} }
  const sensitiveRoots = resolveSensitivePathRoots(sensitiveOptions)
  const sensitive = createSensitivePathMatcher(sensitiveOptions)
  const grants: SandboxFilesystemGrant[] = []
  for (const root of roots) {
    signal.throwIfAborted()
    if (/[*?[\]{}\n\r]/.test(root) || !(await stat(root)).isDirectory()
      || sensitiveRoots.some(path => containsCanonicalPath(path, root))
      || input.protectedRoots.some(path => containsCanonicalPath(path, root) && !workspaces.some(workspace => containsCanonicalPath(workspace, root)) && !resources.includes(root))) {
      throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
    }
    const writable = !input.readOnly && (input.roots.includes(root) || input.additionalDirectories.some(grant => grant.path === root && grant.access === 'write'))
    grants.push(await inspectSandboxPath(root, writable ? 'write' : 'read'))
  }
  if (!roots.some(root => containsCanonicalPath(root, input.cwd)))
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')

  const secrets: string[] = []
  for (const root of roots.filter(root => !roots.some(parent => parent !== root && containsCanonicalPath(parent, root)))) {
    try {
      const result = await execute(rg, ['--files', '--hidden', '--no-ignore', '--null', ...SECRET_GLOBS.flatMap(glob => ['--iglob', glob]), '--', root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, signal, timeout: 15_000, windowsHide: true })
      secrets.push(...result.stdout.split('\0').filter(path => path && sensitive.matches(path)))
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1)
        throw error
    }
  }
  for (const path of await existingSandboxPaths([...secrets, ...sensitiveRoots.filter(path => roots.some(root => containsCanonicalPath(root, path)))]))
    grants.push(await inspectSandboxPath(path, 'denyRead'))
  for (const path of await existingSandboxPaths(input.protectedRoots)) {
    const grant = await inspectSandboxPath(path, 'denyRead')
    grant.exceptions = [...workspaces, ...resources].filter(root => containsCanonicalPath(path, root))
    grants.push(grant)
  }
  for (const path of await existingSandboxPaths(roots.map(root => join(root, '.git'))))
    grants.push(await inspectSandboxPath(path, 'denyWrite'))
  signal.throwIfAborted()
  return grants
}
