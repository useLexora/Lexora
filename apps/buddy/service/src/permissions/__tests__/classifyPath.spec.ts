import type { PermissionGrant } from '../permissionContract'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { classifyPath, toGrantRoot } from '../classifyPath'
import { createSensitivePathMatcher } from '../sensitivePaths'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('classifyPath', () => {
  it.skipIf(process.platform === 'win32')('rejects devices and pipes, including symlinks and create targets', async () => {
    const root = await createRoot()
    const pipe = join(root, 'pipe')
    const link = join(root, 'linked-pipe')
    await promisify(execFile)('mkfifo', [pipe])
    await symlink(pipe, link)
    for (const path of [pipe, link, '/dev/null']) {
      for (const mode of ['existing', 'create'] as const) {
        await expect(classifyPath({
          cwd: root,
          grants: [grant('workspace', root, 'workspace')],
          mode,
          path,
          sensitive: createSensitivePathMatcher({ home: join(root, 'home') }),
        })).rejects.toMatchObject({ code: 'INVALID_PATH' })
      }
    }
  })

  it('classifies workspace, granted and outside paths after realpath resolution', async () => {
    const root = await createRoot()
    const workspace = await createDirectory(root, 'workspace')
    const granted = await createDirectory(root, 'granted')
    const outside = await createDirectory(root, 'outside')
    const grants: PermissionGrant[] = [
      grant('workspace', workspace, 'workspace'),
      grant('granted', granted, 'granted'),
    ]
    const sensitive = createSensitivePathMatcher({ home: join(root, 'home') })

    await expect(classifyPath({
      cwd: workspace,
      grants,
      mode: 'existing',
      path: workspace,
      sensitive,
    })).resolves.toMatchObject({ isDirectory: true, zone: 'workspace' })
    await expect(classifyPath({
      cwd: workspace,
      grants,
      mode: 'existing',
      path: granted,
      sensitive,
    })).resolves.toMatchObject({ isDirectory: true, zone: 'granted' })
    await expect(classifyPath({
      cwd: workspace,
      grants,
      mode: 'existing',
      path: outside,
      sensitive,
    })).resolves.toMatchObject({ isDirectory: true, zone: 'outside' })
  })

  it('classifies a symlink by its real sensitive target', async () => {
    const root = await createRoot()
    const home = await createDirectory(root, 'home')
    const ssh = await createDirectory(home, '.ssh')
    const workspace = await createDirectory(root, 'workspace')
    const secret = join(ssh, 'id_ed25519')
    const link = join(workspace, 'notes.txt')
    await writeFile(secret, 'secret')
    await symlink(secret, link)

    await expect(classifyPath({
      cwd: workspace,
      grants: [grant('workspace', workspace, 'workspace')],
      mode: 'existing',
      path: link,
      sensitive: createSensitivePathMatcher({ home }),
    })).resolves.toMatchObject({ canonicalPath: secret, zone: 'sensitive' })
  })

  it('proposes the direct parent for a file whose parent does not exist yet', async () => {
    const root = await createRoot()
    const workspace = await createDirectory(root, 'workspace')
    const outside = await createDirectory(root, 'outside')
    const classification = await classifyPath({
      cwd: workspace,
      grants: [grant('workspace', workspace, 'workspace')],
      mode: 'create',
      path: join(outside, 'nested', 'draft.md'),
      sensitive: createSensitivePathMatcher({ home: join(root, 'home') }),
    })

    expect(classification).toMatchObject({ isDirectory: false, zone: 'outside' })
    expect(toGrantRoot(classification)).toBe(join(outside, 'nested'))
  })

  it('preserves sensitivity when a protected directory points into an ordinary workspace', async () => {
    const root = await createRoot()
    const home = await createDirectory(root, 'home')
    const workspace = await createDirectory(root, 'workspace')
    const file = join(workspace, 'config')
    await writeFile(file, 'synthetic fixture')
    await symlink(workspace, join(home, '.ssh'), 'junction')

    await expect(classifyPath({
      cwd: workspace,
      grants: [grant('workspace', workspace, 'workspace')],
      mode: 'existing',
      path: join(home, '.ssh', 'config'),
      sensitive: createSensitivePathMatcher({ home }),
    })).resolves.toMatchObject({ canonicalPath: file, zone: 'sensitive' })
  })

  it('does not broaden an existing directory target to its parent in create mode', async () => {
    const root = await createRoot()
    const workspace = await createDirectory(root, 'workspace')
    const outside = await createDirectory(root, 'outside')
    const classification = await classifyPath({
      cwd: workspace,
      grants: [grant('workspace', workspace, 'workspace')],
      mode: 'create',
      path: outside,
      sensitive: createSensitivePathMatcher({ home: join(root, 'home') }),
    })

    expect(classification).toMatchObject({ isDirectory: true, zone: 'outside' })
    expect(toGrantRoot(classification)).toBe(outside)
  })
})

function grant(
  grantId: string,
  root: string,
  kind: PermissionGrant['kind'],
): PermissionGrant {
  return { canonicalRoot: root, grantId, kind, root }
}

async function createRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-permission-')))
  roots.push(root)
  return root
}

async function createDirectory(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return realpath(path)
}
