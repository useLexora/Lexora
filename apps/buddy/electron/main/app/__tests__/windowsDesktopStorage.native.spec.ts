import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest'
import { inspectWindowsPrivateDirectory as inspect } from '../../../../platform/filesystem/__tests__/windowsPrivateDirectoryFixture'
import { resolveBuddyPrivateDirectories } from '../../../../platform/native/nativeHost'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { readDiagnosticError } from '../../../../shared/diagnostics/applicationDiagnostic'
import { checkDesktopDirectories, prepareDesktopPrivateStorage } from '../desktopStorage'

const privateAcl = 'D:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
const additionalPrincipal = 'S-1-5-21-111111111-222222222-333333333-1001'
const inheritedAcl = `${privateAcl}(A;OICI;0x1200a9;;;${additionalPrincipal})`

describe.skipIf(process.platform !== 'win32')('windows desktop storage', () => {
  let helper: string
  let root: string

  beforeAll(() => {
    const executable = resolveBuddyPrivateDirectories({ appPath: fileURLToPath(new URL('../../../../', import.meta.url)), isPackaged: false, resourcesPath: '' })
    assert.ok(executable, 'Build the Windows native helpers before running runtime tests')
    helper = executable
  })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lexora-desktop-storage-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true })
  })

  it('preserves inherited read-execute grants, files and ACLs across repeated startup checks', async () => {
    const parent = join(root, 'inherited-parent')
    await mkdir(parent)
    const parentSecurity = inspect(parent, inheritedAcl)
    const home = join(parent, 'ordinary-mkdir-home')
    const userData = join(home, '.runtime', 'electron')
    await mkdir(userData, { recursive: true })
    const before = inspect(home)
    assert.ok(before.allows.includes(additionalPrincipal))
    assert.ok(before.inherited.every(Boolean))
    const sentinel = join(home, 'preserved.txt')
    await writeFile(sentinel, 'existing product data')
    const fileSecurity = inspect(sentinel)
    for (let launch = 0; launch < 2; launch++) {
      prepareDesktopPrivateStorage(home, helper)
      await checkDesktopDirectories({ lexora_home: home, user_data: userData }, helper)
    }
    assert.equal(inspect(parent).sddl, parentSecurity.sddl)
    assert.equal(inspect(home).sddl, before.sddl)
    assert.equal(inspect(sentinel).sddl, fileSecurity.sddl)
    assert.equal(await readFile(sentinel, 'utf8'), 'existing product data')
    assert.deepEqual((await readdir(home)).sort(), ['.runtime', 'preserved.txt'])
    assert.deepEqual(await readdir(userData), [])
  }, 60_000)

  it('creates a protected product root before nested Electron directories without changing the parent', async () => {
    const parent = join(root, 'inherited-parent')
    await mkdir(parent)
    const parentSecurity = inspect(parent, inheritedAcl)
    const home = join(parent, 'private-product-home')
    prepareDesktopPrivateStorage(home, helper)
    const security = inspect(home)
    assert.equal(security.protected, true)
    assert.deepEqual(security.allows.sort(), [security.user, 'S-1-5-18', 'S-1-5-32-544'].sort())
    const userData = join(home, '.runtime', 'electron')
    await checkDesktopDirectories({ lexora_home: home, user_data: userData }, helper)
    assert.ok(!inspect(userData).allows.includes(additionalPrincipal))
    assert.equal(inspect(home).sddl, security.sddl)
    assert.equal(inspect(parent).sddl, parentSecurity.sddl)
  }, 60_000)

  it('preserves inherited runtime directory ACLs and files without leaving probe files', async () => {
    const parent = join(root, 'inherited-parent')
    await mkdir(parent)
    inspect(parent, inheritedAcl)
    const runtime = {
      user_data: join(parent, 'electron'),
      session_data: join(parent, 'chromium'),
      window_state: join(parent, 'state'),
    }
    const before = new Map<string, string>()
    for (const directory of Object.values(runtime)) {
      await mkdir(directory)
      const security = inspect(directory)
      before.set(directory, security.sddl)
      assert.ok(security.allows.includes(additionalPrincipal))
      await writeFile(join(directory, 'preserved.txt'), 'existing runtime data')
    }
    for (let launch = 0; launch < 2; launch++)
      await checkDesktopDirectories(runtime, helper)
    for (const directory of Object.values(runtime)) {
      assert.equal(inspect(directory).sddl, before.get(directory))
      assert.equal(await readFile(join(directory, 'preserved.txt'), 'utf8'), 'existing runtime data')
      assert.deepEqual(await readdir(directory), ['preserved.txt'])
    }
  }, 60_000)

  it('accepts read-execute grants added to existing product storage without ACL repair', async () => {
    const home = join(root, 'private-product-home')
    prepareDesktopPrivateStorage(home, helper)
    const sentinel = join(home, 'preserved.txt')
    await writeFile(sentinel, 'existing product data')
    const before = inspect(home, inheritedAcl)
    for (let launch = 0; launch < 2; launch++) {
      prepareDesktopPrivateStorage(home, helper)
      await checkDesktopDirectories({ lexora_home: home }, helper)
    }
    assert.equal(inspect(home).sddl, before.sddl)
    assert.equal(await readFile(sentinel, 'utf8'), 'existing product data')
  }, 60_000)

  it('rejects read-execute plus write before loading without ACL repair or diagnostic identity disclosure', async () => {
    const home = join(root, 'private-product-home')
    prepareDesktopPrivateStorage(home, helper)
    const sentinel = join(home, 'preserved.txt')
    await writeFile(sentinel, 'existing product data')
    const before = inspect(home, `${privateAcl}(A;OICI;0x1200ab;;;${additionalPrincipal})`)
    const isPrivateFailure = (error: unknown) => {
      assert.ok(error instanceof PrivateDirectoryError)
      assert.equal(error.code, 'PRIVATE_DIRECTORIES_UNSAFE')
      assert.equal(error.failure.directoryRole, 'lexora_home')
      assert.equal(error.failure.acl?.accessMask, 0x1200AB)
      const diagnostic = JSON.stringify(readDiagnosticError(error))
      assert.ok(!diagnostic.includes(additionalPrincipal))
      assert.ok(!diagnostic.includes(root))
      return true
    }
    assert.throws(() => prepareDesktopPrivateStorage(home, helper), isPrivateFailure)
    await assert.rejects(checkDesktopDirectories({ lexora_home: home, user_data: join(root, 'not-created') }, helper), isPrivateFailure)
    assert.ok(!(await readdir(root)).includes('not-created'))
    assert.equal(inspect(home).sddl, before.sddl)
    assert.equal(await readFile(sentinel, 'utf8'), 'existing product data')
  }, 60_000)

  it('reports actual file-creation denial without overwriting existing runtime data', async () => {
    const userData = join(root, 'electron')
    await mkdir(userData)
    const sentinel = join(userData, 'preserved.txt')
    await writeFile(sentinel, 'existing runtime data')
    const before = inspect(userData)
    const denied = inspect(userData, 'D:P(D;;0x2;;;CURRENT)(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    try {
      await assert.rejects(checkDesktopDirectories({ user_data: userData }), (error: unknown) => {
        const diagnostic = readDiagnosticError(error)
        assert.equal(diagnostic.errorCode, 'DESKTOP_BOOTSTRAP_FAILED')
        assert.equal(diagnostic.failure?.kind, 'desktop_bootstrap')
        if (diagnostic.failure?.kind !== 'desktop_bootstrap')
          return false
        assert.equal(diagnostic.failure.operation, 'probe_directory')
        assert.equal(diagnostic.failure.directoryRole, 'user_data')
        assert.ok(['EACCES', 'EPERM'].includes(diagnostic.failure.systemCode ?? ''))
        return true
      })
      assert.equal(inspect(userData).sddl, denied.sddl)
      assert.equal(await readFile(sentinel, 'utf8'), 'existing runtime data')
    }
    finally {
      inspect(userData, before.sddl)
    }
  }, 60_000)

  it('fails before creating product storage if the private-directory helper is missing', async () => {
    const unavailable = join(root, 'missing-helper-home')
    assert.throws(() => prepareDesktopPrivateStorage(unavailable), { code: 'PRIVATE_DIRECTORIES_UNAVAILABLE' })
    assert.deepEqual(await readdir(root), [])
  })
})
