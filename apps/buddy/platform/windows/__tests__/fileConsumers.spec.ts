import type { BrowserSecuritySession } from '../../../electron/main/browser/BrowserSecurityPolicy'
import { describe, expect, it, vi } from 'vitest'
import { BrowserSecurityPolicy } from '../../../electron/main/browser/BrowserSecurityPolicy'
import { resolveRendererAssetPath } from '../../../electron/main/rendererProtocol'
import { createBuddyToolPresentation } from '../../../service/src/agent/events/toolPresentation'
import { resolveGrantedPath } from '../../../service/src/directories/resolveGrantedPath'
import { classifyPath } from '../../../service/src/permissions/classifyPath'
import { createSensitivePathMatcher } from '../../../service/src/permissions/sensitivePaths'
import { filePaths, relativeCanonicalPath } from '../../filesystem/filePaths'

vi.mock('../../currentPlatform', async () => {
  const { resolveBuddyPlatform } = await import('../../../shared/platform')
  return { currentPlatform: resolveBuddyPlatform('win32') }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, ...actual.win32 }
})
vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>()
  return {
    ...actual,
    fileURLToPath: (url: URL) => actual.fileURLToPath(url, { windows: true }),
    pathToFileURL: (path: string) => actual.pathToFileURL(path, { windows: true }),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (path: string) => path,
    stat: async (path: string) => ({
      isDirectory: () => !path.endsWith('.html'),
      isFile: () => path.endsWith('.html'),
    }),
  }
})

describe('windows file consumers with simulated filesystem', () => {
  it.each([
    ['C:\\workspace\\docs\\说明.md', 'docs/说明.md'],
    ['D:\\outside\\notes.md', 'D:\\outside\\notes.md'],
  ])('shows Windows file paths without losing their location: %s', (path, expected) => {
    for (const toolName of ['read', 'write', 'edit', 'find', 'grep', 'ls']) {
      expect(createBuddyToolPresentation({ arguments: { path }, canonicalRoot: 'C:\\workspace', toolName }))
        .toMatchObject({ path: expected })
    }
  })

  it.each([
    ['C:\\workspace', 'c:\\workspace', ''],
    ['C:\\workspace\\', 'c:\\workspace\\docs\\note.html', 'docs\\note.html'],
    ['C:\\workspace', 'D:\\workspace\\note.html', null],
    ['C:\\workspace', 'C:\\Workspace\\note.html', null],
    ['C:\\workspace', 'C:\\workspace-other\\index.html', null],
    ['C:\\workspace', 'C:\\workspace\\..\\outside.html', null],
    ['C:\\workspace', 'C:\\workspace\\file:stream', null],
    ['\\\\server\\share\\root', '\\\\server\\share\\root\\文档.html', '文档.html'],
    ['\\\\server\\share\\root', '\\\\server\\other\\root\\文档.html', null],
  ])('derives relative paths only within canonical boundaries: %s, %s', (root, path, expected) => {
    expect(relativeCanonicalPath(root, path)).toBe(expected)
  })

  it('resolves ordinary relative inputs but checks raw segments before normalization', () => {
    expect(filePaths.resolveInput('文档/notes.html', 'C:\\workspace')).toBe('C:\\workspace\\文档\\notes.html')
    expect(() => filePaths.resolveInput('NUL/../notes.html', 'C:\\workspace')).toThrow()
  })

  it('rejects alternate streams before resolving a directory grant', async () => {
    await expect(resolveGrantedPath([{
      canonicalRoot: 'C:\\workspace',
      grantId: 'fixture',
      kind: 'workspace',
      root: 'C:\\workspace',
    }], 'C:\\workspace\\notes.html:secret', 'existing')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('protects redirected profile roots without confusing similarly named ordinary directories', () => {
    const sensitive = createSensitivePathMatcher({
      home: 'C:\\Users\\Fixture',
      environment: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' },
    })
    expect(sensitive.matches('d:\\local\\microsoft\\vault\\fixture')).toBe(true)
    expect(sensitive.matches('D:\\Roaming\\Mozilla\\Firefox\\Profiles\\fixture')).toBe(true)
    expect(sensitive.matches('C:\\Users\\Fixture\\.ssh\\.env.example')).toBe(true)
    expect(sensitive.matches('C:\\Users\\Fixture\\.ssh-other\\config')).toBe(false)
    expect(sensitive.matches('C:\\workspace\\.env.example')).toBe(false)
  })

  it.each(['D:\\outside\\index.html', 'C:\\Workspace\\index.html'])('rejects browser targets outside the canonical root: %s', async (entry) => {
    const policy = createPolicy()
    try {
      await expect(policy.authorizeLocalFile(entry, 'C:\\workspace'))
        .rejects
        .toMatchObject({ reason: 'INVALID_TARGET' })
    }
    finally {
      policy.dispose()
    }
  })

  it('allows a browser document inside its canonical root', async () => {
    const policy = createPolicy()
    try {
      await expect(policy.authorizeLocalFile('C:\\workspace\\index.html', 'C:\\workspace'))
        .resolves
        .toBe('file:///C:/workspace/index.html')
    }
    finally {
      policy.dispose()
    }
  })

  it('blocks renderer assets on another drive', () => {
    expect(resolveRendererAssetPath('lexora-app://renderer/D:/outside/index.html', 'C:\\app\\renderer')).toBeNull()
  })

  it('rejects alternate streams before classifying permission inputs', async () => {
    await expect(classifyPath({
      cwd: 'C:\\workspace',
      grants: [],
      mode: 'existing',
      path: 'C:\\workspace\\.env:stream',
      sensitive: createSensitivePathMatcher({ home: 'C:\\Users\\Fixture', environment: {} }),
    })).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it.each([
    'C:\\Users\\Fixture\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies',
    'c:\\users\\fixture\\appdata\\local\\microsoft\\edge\\user data\\Default\\Cookies',
    'C:\\Users\\Fixture\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\fixture\\cookies.sqlite',
    'C:\\Users\\Fixture\\.SSH\\config',
  ])('recognizes Windows secret locations with default profile roots: %s', (path) => {
    expect(createSensitivePathMatcher({ home: 'C:\\Users\\Fixture', environment: {} }).matches(path)).toBe(true)
  })
})

function createPolicy() {
  const session: BrowserSecuritySession = {
    off: () => {},
    on: () => {},
    setPermissionCheckHandler: () => {},
    setPermissionRequestHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
  }
  return new BrowserSecurityPolicy({
    page: {
      on: () => {},
      off: () => {},
      id: 1,
      debugger: { attach: () => {}, detach: () => {}, isAttached: () => true, sendCommand: async () => ({}) },
      getURL: () => 'about:blank',
      loadURL: async () => {},
      setWindowOpenHandler: () => {},
    },
    session,
  })
}
