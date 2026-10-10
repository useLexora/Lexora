import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest'
import { resolveBuddyPrivateDirectories } from '../../native/nativeHost'
import { PrivateDirectoryError } from '../../windows/privateDirectories'
import { ensurePrivateDirectories } from '../privateDirectories'
import { inspectWindowsPrivateDirectory as inspect } from './windowsPrivateDirectoryFixture'

async function missing(path: string) {
  await assert.rejects(access(path), { code: 'ENOENT' })
}

describe.skipIf(process.platform !== 'win32')('windows private directories', () => {
  let helper: string
  let directory: string
  const junctions: string[] = []

  beforeAll(() => {
    const executable = resolveBuddyPrivateDirectories({ appPath: fileURLToPath(new URL('../../../', import.meta.url)), isPackaged: false, resourcesPath: '' })
    assert.ok(executable, 'Build the Windows native helpers before running platform tests')
    helper = executable
  })
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'buddy-private-contract-'))
  })
  afterEach(async () => {
    for (const junction of junctions.splice(0))
      await unlink(junction)
    await rm(directory, { recursive: true })
  })

  it('creates protected Unicode directories and preserves inherited file ACLs on repeated checks', async () => {
    const privatePath = join(directory, '示例', 'private')
    await ensurePrivateDirectories([privatePath], helper)
    await access(privatePath)
    const security = inspect(privatePath)
    assert.equal(security.owner, security.user)
    assert.equal(security.protected, true)
    assert.deepEqual(security.allows.sort(), [security.user, 'S-1-5-18', 'S-1-5-32-544'].sort())
    const file = join(privatePath, 'preserved.txt')
    await writeFile(file, 'fixture')
    const fileSecurity = inspect(file)
    assert.deepEqual(fileSecurity.allows.sort(), security.allows)
    assert.ok(fileSecurity.inherited.every(Boolean))
    await ensurePrivateDirectories([privatePath, privatePath], helper)
    await ensurePrivateDirectories([privatePath.toUpperCase()], helper)
    assert.equal(inspect(privatePath).sddl, security.sddl)
    assert.equal(await readFile(file, 'utf8'), 'fixture')
  }, 60_000)

  it('preserves existing inherited CREATOR OWNER templates and data', async () => {
    const inheritedParent = join(directory, 'creator-owner-parent')
    await mkdir(inheritedParent)
    const parentSecurity = inspect(inheritedParent, 'O:CURRENTD:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;CO)')
    const inheritedDirectory = join(inheritedParent, 'existing', 'session-data')
    await mkdir(inheritedDirectory, { recursive: true })
    const inheritedSecurity = inspect(inheritedDirectory)
    assert.ok(inheritedSecurity.allows.includes('S-1-3-0'))
    const preserved = join(inheritedDirectory, 'preserved.txt')
    await writeFile(preserved, 'existing-user-data')
    await ensurePrivateDirectories([inheritedDirectory], helper)
    await ensurePrivateDirectories([inheritedDirectory], helper)
    assert.equal(inspect(inheritedParent).sddl, parentSecurity.sddl)
    assert.equal(inspect(inheritedDirectory).sddl, inheritedSecurity.sddl)
    assert.equal(await readFile(preserved, 'utf8'), 'existing-user-data')
    assert.ok(!inspect(preserved).allows.includes('S-1-3-0'))
  }, 60_000)

  it('preserves existing access grants and data without rewriting directory or file ACLs', async () => {
    for (const [name, sddl] of [
      ['managed-write', 'D:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)'],
      ['everyone-write', 'D:P(A;OICI;FA;;;WD)'],
      ['null-dacl', 'D:NO_ACCESS_CONTROL'],
    ]) {
      const path = join(directory, name!)
      await ensurePrivateDirectories([path], helper)
      const before = inspect(path, sddl)
      const sentinel = join(path, 'preserved.txt')
      await writeFile(sentinel, 'existing-user-data')
      const sentinelSecurity = inspect(sentinel)
      await ensurePrivateDirectories([path], helper)
      await ensurePrivateDirectories([path], helper)
      assert.equal(inspect(path).sddl, before.sddl)
      assert.equal(inspect(sentinel).sddl, sentinelSecurity.sddl)
      assert.equal(await readFile(sentinel, 'utf8'), 'existing-user-data')
    }
  }, 60_000)

  it('rejects leaf and ancestor junctions without touching their destination', async () => {
    const target = join(directory, 'junction-target')
    const junction = join(directory, 'junction')
    await mkdir(target)
    const targetSecurity = inspect(target)
    await symlink(target, junction, 'junction')
    junctions.push(junction)
    await assert.rejects(ensurePrivateDirectories([junction], helper))
    await assert.rejects(ensurePrivateDirectories([join(junction, 'escaped')], helper))
    await missing(join(target, 'escaped'))
    assert.equal(inspect(target).sddl, targetSecurity.sddl)
  }, 60_000)

  it('rejects files, user home, volume roots and raw stream or device aliases', async () => {
    const file = join(directory, 'preserved.txt')
    await writeFile(file, 'fixture')
    await assert.rejects(ensurePrivateDirectories([file], helper), (error: unknown) => {
      assert.ok(error instanceof PrivateDirectoryError)
      assert.equal(error.code, 'PRIVATE_DIRECTORIES_FAILED')
      assert.equal(error.failure.operation, 'open_directory')
      assert.equal(error.failure.systemError?.domain, 'ntstatus')
      assert.equal(error.failure.directoryIndex, 0)
      return true
    })
    assert.equal(await readFile(file, 'utf8'), 'fixture')
    for (const forbidden of [homedir(), homedir().toUpperCase(), parse(directory).root, `${directory}\\bad:stream\\..\\escaped`, `${directory}\\NUL\\..\\escaped`])
      await assert.rejects(ensurePrivateDirectories([forbidden], helper))
    await missing(join(directory, 'escaped'))
  }, 60_000)

  it('fails closed without the helper and leaves empty batches untouched', async () => {
    const absentHelperTarget = join(directory, 'absent-helper')
    await assert.rejects(ensurePrivateDirectories([absentHelperTarget]))
    await missing(absentHelperTarget)
    await ensurePrivateDirectories([], helper)
  }, 60_000)
})
