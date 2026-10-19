import type { SandboxProcessInput } from '../../../shared/permissions/shellSandbox'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'
import { validateSandboxDirectory } from './SandboxDirectoryPermissions'

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

export type SandboxFilesystemPolicyInput = Pick<SandboxProcessInput, 'additionalDirectories' | 'resourceReadRoots' | 'roots' | 'workspaceRoots' | 'home' | 'backend' | 'readOnly' | 'protectedRoots' | 'sensitiveRoots' | 'cwd'>

export function existingSandboxSensitivePaths(input: Pick<SandboxFilesystemPolicyInput, 'backend' | 'sensitiveRoots'>): Promise<string[]> {
  const systemCredentials = input.backend.kind === SHELL_SANDBOX_BACKEND.Windows ? filePaths.sensitiveKey(join(input.backend.systemRoot, 'System32', 'config')) : undefined
  return existingSandboxPaths(input.sensitiveRoots.filter(path => filePaths.sensitiveKey(path) !== systemCredentials))
}

export async function createSandboxFilesystemPolicy(input: SandboxFilesystemPolicyInput, signal: AbortSignal): Promise<SandboxFilesystemGrant[]> {
  signal.throwIfAborted()
  await Promise.all(input.additionalDirectories.map(validateSandboxDirectory))
  const resources = (input.resourceReadRoots ?? []).filter(root => !input.roots.some(parent => containsCanonicalPath(parent, root)))
  const roots = [...new Set([...input.roots, ...input.additionalDirectories.map(grant => grant.path), ...resources])]
  const workspaces = input.workspaceRoots.filter(root => input.roots.includes(root))
  const sensitiveRoots = input.sensitiveRoots
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

  for (const path of await existingSandboxSensitivePaths(input))
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
