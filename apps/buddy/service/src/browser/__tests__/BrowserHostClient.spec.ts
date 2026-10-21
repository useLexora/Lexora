import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostClient } from '../BrowserHostClient'

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'

const READY_STATE = {
  canGoBack: false,
  canGoForward: false,
  controller: 'human',
  controlEpoch: 0,
  conversationId: 'conversation-1',
  error: null,
  pageId: PAGE_ID,
  profileMode: 'default',
  security: { kind: 'secure', origin: 'https://example.com' },
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Example',
  url: 'https://example.com/docs',
  visible: false,
} as const

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })))
})

describe('browserHostClient', () => {
  it('requests and strictly validates a conversation-bound adapter lease', async () => {
    const lease = {
      conversationId: 'conversation-1',
      expiresAt: '2026-09-02T00:01:00.000Z',
      pageId: PAGE_ID,
      protocolVersion: 1,
      sessionId: SESSION_ID,
      socketPath: '/run/user/1000/lexora-buddy/browser-adapter.sock',
      token: 'a'.repeat(64),
    }
    const request = vi.fn().mockResolvedValue(lease)
    const client = new BrowserHostClient({ request })

    await expect(client.createAdapterLease({
      conversationId: 'conversation-1',
    })).resolves.toEqual(lease)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'host.browser.createAdapterLease',
      { conversationId: 'conversation-1' },
    )

    request.mockResolvedValueOnce({ ...lease, token: 'short' })
    await expect(client.createAdapterLease({
      conversationId: 'conversation-1',
    })).rejects.toThrow()
  })

  it('resolves an existing granted local file before sending a grant-shaped Main request', async () => {
    const root = await createTemporaryDirectory()
    const linkContainer = await createTemporaryDirectory()
    const canonicalRoot = await realpath(root)
    const grantedRoot = join(linkContainer, 'workspace')
    await symlink(root, grantedRoot, 'dir')
    const entryPath = join(grantedRoot, 'site', 'index.html')
    await mkdir(join(root, 'site'))
    await writeFile(entryPath, '<!doctype html><title>Report</title>')
    const request = vi.fn().mockResolvedValue({ ok: true, state: READY_STATE })
    const client = new BrowserHostClient({ request })

    await expect(client.openLocal({
      conversationId: 'conversation-1',
      entryPath,
      grants: [{ canonicalRoot, grantId: 'space-1', kind: 'workspace' as const, root: grantedRoot }],
    })).resolves.toEqual({ ok: true, state: READY_STATE })

    expect(request).toHaveBeenCalledExactlyOnceWith('host.browser.open', {
      conversationId: 'conversation-1',
      target: {
        entryPath: await realpath(entryPath),
        kind: 'local-file',
        rootPath: canonicalRoot,
      },
    }, null, expect.any(AbortSignal), expect.any(String))
  })

  it('rejects direct and symlink escapes without calling Main', async () => {
    const root = await createTemporaryDirectory()
    const outsideRoot = await createTemporaryDirectory()
    const canonicalRoot = await realpath(root)
    const outsidePath = join(outsideRoot, 'outside.html')
    const linkedPath = join(root, 'linked.html')
    await writeFile(outsidePath, '<!doctype html><title>Outside</title>')
    await symlink(outsidePath, linkedPath)
    const request = vi.fn()
    const client = new BrowserHostClient({ request })
    const grant = { canonicalRoot, grantId: 'space-1', kind: 'workspace' as const, root }

    await expect(client.openLocal({
      conversationId: 'conversation-1',
      entryPath: outsidePath,
      grants: [grant],
    })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    await expect(client.openLocal({
      conversationId: 'conversation-1',
      entryPath: linkedPath,
      grants: [grant],
    })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves the stable stale-target recovery envelope from Main', async () => {
    const stale = {
      error: {
        code: 'BROWSER_TARGET_STALE',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    } as const
    const request = vi.fn().mockResolvedValue(stale)
    const client = new BrowserHostClient({ request })

    await expect(client.act({
      action: { kind: 'click', ref: 'e1' },
      controlEpoch: 1,
      documentRevision: 1,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual(stale)
    await expect(client.validateAction({
      action: { kind: 'click', ref: 'e1' },
      documentRevision: 1,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual(stale)
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lexora-browser-host-client-'))
  temporaryDirectories.push(path)
  return path
}
