import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { inspectWindowsPrivateDirectory as inspect } from '../../../../platform/filesystem/__tests__/windowsPrivateDirectoryFixture'
import { ensurePrivateDirectories } from '../../../../platform/filesystem/privateDirectories'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { readDiagnosticError } from '../../../../shared/diagnostics/applicationDiagnostic'
import { checkDesktopDirectories, prepareDesktopPrivateStorage } from '../desktopStorage'

assert.equal(process.platform, 'win32')
const [helperArgument, resultPath] = process.argv.slice(2)
assert.ok(helperArgument && resultPath)
const helper = resolve(helperArgument)
const root = await mkdtemp(join(tmpdir(), 'lexora-desktop-storage-'))
const checks: string[] = []
const privateAcl = 'D:P(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
const additionalPrincipal = 'S-1-5-21-111111111-222222222-333333333-1001'
const inheritedAcl = `${privateAcl}(A;OICI;0x1200a9;;;${additionalPrincipal})`

try {
  const parent = join(root, 'inherited-parent')
  await mkdir(parent)
  const parentSecurity = inspect(parent, inheritedAcl)
  const legacyHome = join(parent, 'ordinary-mkdir-home')
  await mkdir(join(legacyHome, '.runtime', 'electron'), { recursive: true })
  const legacySecurity = inspect(legacyHome)
  assert.ok(legacySecurity.allows.includes(additionalPrincipal))
  await assert.rejects(ensurePrivateDirectories([legacyHome], helper), { code: 'PRIVATE_DIRECTORIES_UNSAFE' })
  assert.equal(inspect(legacyHome).sddl, legacySecurity.sddl)
  checks.push('ordinary recursive mkdir reproduces inherited ACL rejection without changing the existing directory')

  const home = join(parent, 'private-product-home')
  prepareDesktopPrivateStorage(home, helper)
  const homeSecurity = inspect(home)
  assert.equal(homeSecurity.protected, true)
  assert.deepEqual(homeSecurity.allows.sort(), [homeSecurity.user, 'S-1-5-18', 'S-1-5-32-544'].sort())
  const sentinel = join(home, 'preserved.txt')
  await writeFile(sentinel, 'existing product data')
  await checkDesktopDirectories({ lexora_home: home, user_data: join(home, '.runtime', 'electron') }, helper)
  assert.ok(!inspect(join(home, '.runtime', 'electron')).allows.includes(additionalPrincipal))
  assert.equal(inspect(parent).sddl, parentSecurity.sddl)
  checks.push('private product root is created before nested Electron directories without inheriting extra grants or modifying the parent')

  const runtime = {
    user_data: join(parent, 'electron'),
    session_data: join(parent, 'chromium'),
    window_state: join(parent, 'state'),
  }
  const before = new Map<string, string>()
  for (const directory of Object.values(runtime)) {
    await mkdir(directory)
    before.set(directory, inspect(directory).sddl)
    assert.ok(inspect(directory).allows.includes(additionalPrincipal))
    await writeFile(join(directory, 'preserved.txt'), 'existing runtime data')
  }
  for (let launch = 0; launch < 2; launch++) {
    prepareDesktopPrivateStorage(home, helper)
    await checkDesktopDirectories({ lexora_home: home, ...runtime }, helper)
  }
  for (const directory of Object.values(runtime)) {
    assert.equal(inspect(directory).sddl, before.get(directory))
    assert.equal(await readFile(join(directory, 'preserved.txt'), 'utf8'), 'existing runtime data')
    assert.deepEqual(await readdir(directory), ['preserved.txt'])
  }
  assert.equal(inspect(home).sddl, homeSecurity.sddl)
  assert.equal(await readFile(sentinel, 'utf8'), 'existing product data')
  checks.push('Electron session and state directories accept inherited read grants across repeated checks while preserving ACLs and data')

  const unsafe = inspect(home, inheritedAcl)
  const isPrivateFailure = (error: unknown) => {
    assert.ok(error instanceof PrivateDirectoryError)
    assert.equal(error.code, 'PRIVATE_DIRECTORIES_UNSAFE')
    assert.equal(error.failure.directoryRole, 'lexora_home')
    assert.equal(error.failure.acl?.accessMask, 0x1200A9)
    const diagnostic = JSON.stringify(readDiagnosticError(error))
    assert.ok(!diagnostic.includes(additionalPrincipal))
    assert.ok(!diagnostic.includes(root))
    return true
  }
  try {
    assert.throws(() => prepareDesktopPrivateStorage(home, helper), isPrivateFailure)
    await assert.rejects(checkDesktopDirectories({ lexora_home: home, user_data: join(root, 'not-created') }, helper), isPrivateFailure)
    assert.ok(!(await readdir(root)).includes('not-created'))
    assert.equal(inspect(home).sddl, unsafe.sddl)
    assert.equal(await readFile(sentinel, 'utf8'), 'existing product data')
  }
  finally {
    inspect(home, homeSecurity.sddl)
  }
  checks.push('the same grant on product storage still blocks loading without ACL repair, file changes or diagnostic identity disclosure')

  const denied = inspect(runtime.user_data, 'D:P(D;;0x2;;;CURRENT)(A;OICI;FA;;;CURRENT)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  try {
    await assert.rejects(checkDesktopDirectories({ user_data: runtime.user_data }), (error: unknown) => {
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
    assert.equal(inspect(runtime.user_data).sddl, denied.sddl)
    assert.equal(await readFile(join(runtime.user_data, 'preserved.txt'), 'utf8'), 'existing runtime data')
  }
  finally {
    inspect(runtime.user_data, before.get(runtime.user_data))
  }
  checks.push('actual file-creation denial still fails the runtime directory probe without overwriting data')

  const unavailable = join(root, 'missing-helper-home')
  assert.throws(() => prepareDesktopPrivateStorage(unavailable), { code: 'PRIVATE_DIRECTORIES_UNAVAILABLE' })
  assert.ok(!(await readdir(root)).includes('missing-helper-home'))
  checks.push('missing private-directory helper fails before creating product storage')
}
finally {
  await rm(root, { recursive: true })
}

const result = { passed: true, helperSha256: createHash('sha256').update(await readFile(helper)).digest('hex'), checks, fixturesRemoved: true }
await writeFile(resultPath, JSON.stringify(result, null, 2))
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
